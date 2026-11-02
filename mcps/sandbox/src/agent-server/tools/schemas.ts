import { z } from 'zod';
import type { ModelFunctionSchema } from './types.js';
import { fileOperationSchemas, FILE_OPERATION_SCHEMAS } from '../workspace/file-operations.js';

const filePath = z.string().min(1).max(32768);
const byteOffset = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const localArgumentSchemas = {
    read_file: z.object({ path: filePath, offset: byteOffset.default(0), limit: z.number().int().min(1).max(262144).default(65536),
        encoding: z.enum(['utf8', 'base64']).default('utf8') }).strict(),
    write_file: z.object({ path: filePath, content: z.string().max(12 * 1024 * 1024),
        expectedVersion: z.string().regex(/^[a-f0-9]{64}$/), encoding: z.enum(['utf8', 'base64']).default('utf8') }).strict(),
    list_files: z.object({ path: filePath, limit: z.number().int().min(1).max(200).default(100), cursor: z.string().max(2048).optional() }).strict(),
    run_command: z.object({ application: filePath, args: z.array(z.string().max(32768)).max(256).default([]), cwd: filePath,
        stdin: z.string().max(16384).optional(), timeoutMs: z.number().int().min(100).max(3600000).default(30000),
        maxMemoryMB: z.number().int().min(16).max(4096).default(256), maxOutputBytes: z.number().int().min(1024).max(1048576).default(262144),
        writeSet: z.array(filePath).max(200).optional() }).strict(),
    tool_catalog: z.object({ query: z.string().max(256).optional(), cursor: z.string().max(32).optional(),
        limit: z.number().int().min(1).max(100).default(24) }).strict(),
    tool_describe: z.object({ name: z.string().min(1).max(256) }).strict(),
    tool_load: z.object({ names: z.array(z.string().min(1).max(256)).min(1).max(32) }).strict(),
    ...fileOperationSchemas,
};

const stringPath = { type: 'string', description: '完整绝对路径' };

export const MODEL_FUNCTION_SCHEMAS: readonly ModelFunctionSchema[] = [
    { type: 'function', name: 'read_file', description: '分页读取普通文件；获准写入根内返回可用于write_file的expectedVersion，读取缺失文件也可取得新建版本。',
        parameters: { type: 'object', additionalProperties: false, required: ['path'], properties: {
            path: stringPath, offset: { type: 'integer', minimum: 0, description: '字节偏移，默认0' },
            limit: { type: 'integer', minimum: 1, maximum: 262144, description: '最多返回的字节数，默认65536' },
            encoding: { type: 'string', enum: ['utf8', 'base64'] },
        } } },
    { type: 'function', name: 'write_file', description: '在获准根内按read_file返回的expectedVersion写入UTF-8或base64字节，保留修改前后版本；版本变化时先重新读取。父目录须已存在。',
        parameters: { type: 'object', additionalProperties: false, required: ['path', 'content', 'expectedVersion'], properties: {
            path: stringPath, content: { type: 'string' }, expectedVersion: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            encoding: { type: 'string', enum: ['utf8', 'base64'] },
        } } },
    { type: 'function', name: 'list_files', description: '分页列出一个目录的直接子项，目录读取无需写入根授权；返回下一页cursor。',
        parameters: { type: 'object', additionalProperties: false, required: ['path'], properties: {
            path: stringPath, limit: { type: 'integer', minimum: 1, maximum: 200 }, cursor: { type: 'string' },
        } } },
    { type: 'function', name: 'run_command', description: '执行普通程序及明确参数，工作目录和声明写集合须在获准工作区；遵守当前任务规则，不得读取控制凭据或修改控制文件。危险动作先交主调用方批准。Windows Job限制整树内存、超时和输出，取消或结束回收派生进程；命中本机禁止操作时暂停并停止自动重试。',
        parameters: { type: 'object', additionalProperties: false, required: ['application', 'cwd'], properties: {
            application: stringPath, args: { type: 'array', items: { type: 'string' }, maxItems: 256 }, cwd: stringPath,
            stdin: { type: 'string' }, timeoutMs: { type: 'integer', minimum: 100, maximum: 3600000 },
            maxMemoryMB: { type: 'integer', minimum: 16, maximum: 4096 }, maxOutputBytes: { type: 'integer', minimum: 1024, maximum: 1048576 },
            writeSet: { type: 'array', items: stringPath, maxItems: 200, description: '已知会修改的文件，未覆盖效果在回执中单列' },
        } } },
    { type: 'function', name: 'tool_catalog', description: '分页查找本任务可用的本地及共享MCP工具短目录；query按名称、服务和用途匹配，不加载参数定义，也不调用外部模型。先查目录，再按需tool_describe或tool_load。',
        parameters: { type: 'object', additionalProperties: false, properties: {
            query: { type: 'string', maxLength: 256, description: '可选的名称、服务或用途关键词' },
            cursor: { type: 'string', maxLength: 32 }, limit: { type: 'integer', minimum: 1, maximum: 100 },
        } } },
    { type: 'function', name: 'tool_describe', description: '读取一个目录工具的参数定义、schemaHash和可用性；仅描述，使用tool_load后才加入下一次模型请求的工具表。name使用目录返回的toolId或name。',
        parameters: { type: 'object', additionalProperties: false, required: ['name'], properties: {
            name: { type: 'string', minLength: 1, maxLength: 256 },
        } } },
    { type: 'function', name: 'tool_load', description: '按名称选择加载至多32个目录工具，新增定义从下一次模型请求生效，返回名称和固定hash。只加载任务需要的工具；身份、权限、版本与资源归属继续由可信核心绑定。',
        parameters: { type: 'object', additionalProperties: false, required: ['names'], properties: {
            names: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 256 } },
        } } },
    ...FILE_OPERATION_SCHEMAS,
];
