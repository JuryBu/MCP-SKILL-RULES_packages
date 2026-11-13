import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AgentFault, canonicalJson } from '../protocol.js';

const uuidValue = z.string().uuid();

export interface CachedToolSchema {
    serviceId: string;
    name: string;
    revision: string;
    schemaHash: string;
    schema: Record<string, unknown>;
}

export class ToolSchemaCache {
    private readonly entries = new Map<string, CachedToolSchema>();
    private readonly order = new Map<string, number>();
    private nextOrder = 0;
    constructor(readonly capacity = 64) {
        if (!Number.isInteger(capacity) || capacity < 1 || capacity > 1024) throw new AgentFault('INVALID_PARAMS', 'schema缓存容量无效');
    }
    private key(serviceId: string, name: string): string { return JSON.stringify([serviceId, name]); }
    get(serviceId: string, name: string, revision?: string): CachedToolSchema | undefined {
        const key = this.key(serviceId, name);
        const entry = this.entries.get(key);
        if (!entry || (revision !== undefined && entry.revision !== revision)) return undefined;
        this.entries.delete(key);
        this.entries.set(key, entry);
        return structuredClone(entry);
    }
    put(serviceId: string, name: string, revision: string, schema: Record<string, unknown>): CachedToolSchema {
        requireSupportedSchema(schema);
        const entry = { serviceId, name, revision, schema: structuredClone(schema),
            schemaHash: createHash('sha256').update(canonicalJson({ serviceId, name, revision, schema })).digest('hex') };
        const key = this.key(serviceId, name);
        if (!this.order.has(key)) this.order.set(key, this.nextOrder++);
        this.entries.delete(key);
        this.entries.set(key, entry);
        while (this.entries.size > this.capacity) {
            const oldest = this.entries.keys().next().value!;
            this.entries.delete(oldest);
            this.order.delete(oldest);
        }
        return structuredClone(entry);
    }
    list(): CachedToolSchema[] {
        return structuredClone([...this.entries].sort(([left], [right]) => this.order.get(left)! - this.order.get(right)!).map(([, entry]) => entry));
    }
    clear(serviceId?: string): void {
        for (const [key, entry] of this.entries) if (!serviceId || entry.serviceId === serviceId) {
            this.entries.delete(key);
            this.order.delete(key);
        }
    }
}

export function requireSupportedSchema(schema: unknown, depth = 0): void {
    if (depth > 20 || !schema || typeof schema !== 'object' || Array.isArray(schema)) throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '工具schema超出当前校验能力');
    const object = schema as Record<string, unknown>;
    const supported = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'anyOf', 'oneOf', 'not', 'enum', 'const',
        'description', 'title', 'default', 'examples', '$schema', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum',
        'exclusiveMinimum', 'exclusiveMaximum', 'minItems', 'maxItems', 'format']);
    for (const key of Object.keys(object)) if (!supported.has(key)) throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '工具schema包含尚未接入的校验条件', { keyword: key });
    if ('format' in object && object.format !== 'uuid') throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '工具schema的格式尚未接入', { format: String(object.format) });
    for (const keyword of ['exclusiveMinimum', 'exclusiveMaximum']) {
        if (keyword in object && (typeof object[keyword] !== 'number' || !Number.isFinite(object[keyword]))) {
            throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '工具schema需要有限数值边界', { keyword });
        }
    }
    for (const key of ['$ref', '$dynamicRef', 'allOf', 'if', 'then', 'else', 'patternProperties', 'dependentSchemas', 'unevaluatedProperties']) {
        if (key in object) throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '工具schema包含尚未接入的校验条件', { keyword: key });
    }
    if (object.properties && typeof object.properties === 'object') for (const child of Object.values(object.properties)) requireSupportedSchema(child, depth + 1);
    if (object.items) requireSupportedSchema(object.items, depth + 1);
    if (object.additionalProperties && typeof object.additionalProperties === 'object') requireSupportedSchema(object.additionalProperties, depth + 1);
    if ('not' in object) requireSupportedSchema(object.not, depth + 1);
    for (const key of ['anyOf', 'oneOf']) if (Array.isArray(object[key])) for (const child of object[key]) requireSupportedSchema(child, depth + 1);
    if (typeof object.pattern === 'string' && (object.pattern.length > 256 || /[()|]|\\[1-9]/.test(object.pattern))) throw new AgentFault('TOOL_CAPABILITY_UNVERIFIED', '工具schema的文本条件超出当前有界校验范围');
}

export function validateToolArguments(value: unknown, schema: Record<string, unknown>, location = 'args', depth = 0): void {
    const invalid = () => { throw new AgentFault('INVALID_PARAMS', '工具参数不符合已固定的schema', { location }); };
    if (depth > 20) invalid();
    if (schema.not && typeof schema.not === 'object') {
        let matched = false;
        try { validateToolArguments(value, schema.not as Record<string, unknown>, location, depth + 1); matched = true; } catch (error) {
            if (!(error instanceof AgentFault) || error.code !== 'INVALID_PARAMS') throw error;
        }
        if (matched) invalid();
    }
    if (Array.isArray(schema.anyOf)) {
        let accepted = 0;
        for (const branch of schema.anyOf) { try { validateToolArguments(value, branch as Record<string, unknown>, location, depth + 1); accepted++; } catch {} }
        if (!accepted) invalid();
    }
    if (Array.isArray(schema.oneOf)) {
        let accepted = 0;
        for (const branch of schema.oneOf) { try { validateToolArguments(value, branch as Record<string, unknown>, location, depth + 1); accepted++; } catch {} }
        if (accepted !== 1) invalid();
    }
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'object' ? 'object' : typeof value;
    const expected = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
    if (expected.length && !expected.includes(actual) && !(actual === 'number' && expected.includes('integer') && Number.isSafeInteger(value))) invalid();
    if (Array.isArray(schema.enum) && !schema.enum.some(entry => canonicalJson(entry) === canonicalJson(value))) invalid();
    if ('const' in schema && canonicalJson(schema.const) !== canonicalJson(value)) invalid();
    if (typeof value === 'string') {
        if (schema.format === 'uuid' && !uuidValue.safeParse(value).success) invalid();
        if (value.length > Math.min(typeof schema.maxLength === 'number' ? schema.maxLength : 1048576, 1048576)) invalid();
        if (typeof schema.minLength === 'number' && value.length < schema.minLength) invalid();
        if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) invalid();
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || (schema.type === 'integer' && !Number.isSafeInteger(value))) invalid();
        if (typeof schema.minimum === 'number' && value < schema.minimum) invalid();
        if (typeof schema.maximum === 'number' && value > schema.maximum) invalid();
        if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) invalid();
        if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) invalid();
    }
    if (Array.isArray(value)) {
        if (value.length > Math.min(typeof schema.maxItems === 'number' ? schema.maxItems : 256, 256)) invalid();
        if (typeof schema.minItems === 'number' && value.length < schema.minItems) invalid();
        if (schema.items) for (const [index, child] of value.entries()) validateToolArguments(child, schema.items as Record<string, unknown>, `${location}[${index}]`, depth + 1);
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const object = value as Record<string, unknown>;
        const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
        for (const required of (schema.required ?? []) as string[]) if (!(required in object)) invalid();
        for (const [key, child] of Object.entries(object)) {
            const childSchema = Object.hasOwn(properties, key) ? properties[key] : schema.additionalProperties;
            if (childSchema === false) invalid();
            if (childSchema && typeof childSchema === 'object') validateToolArguments(child, childSchema as Record<string, unknown>, `${location}.${key}`, depth + 1);
        }
    }
}
