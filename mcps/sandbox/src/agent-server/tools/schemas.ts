import { z } from 'zod';
import type { ModelFunctionSchema } from './types.js';
import { fileOperationSchemas, FILE_OPERATION_SCHEMAS } from '../workspace/file-operations.js';

const filePath = z.string().min(1).max(32768);
const byteOffset = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const historyRound = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const historyCursor = z.string().min(1).max(16384);
const historyBudget = z.number().int().min(4096).max(262144).default(65536);
const historyRange = { startRound: historyRound.optional(), endRound: historyRound.optional() };

const historyReadSchema = z.object({ summaryId: z.string().min(1).max(256).optional(), artifactId: z.string().min(1).max(256).optional(),
    offset: byteOffset.optional(), ...historyRange, cursor: historyCursor.optional(), limit: z.number().int().min(1).max(100).default(20),
    maxBytes: historyBudget, direction: z.enum(['forward', 'backward']).default('forward') }).strict().superRefine((value, refinement) => {
    if (value.startRound !== undefined && value.endRound !== undefined && value.startRound > value.endRound) {
        refinement.addIssue({ code: 'custom', message: '起始轮不得晚于结束轮' });
    }
    if (value.summaryId && value.artifactId || (value.summaryId || value.artifactId) && (value.startRound !== undefined || value.endRound !== undefined)
        || value.artifactId && value.cursor || value.offset !== undefined && !value.artifactId) {
        refinement.addIssue({ code: 'custom', message: '摘要、正文分片和按轮分页分别选择一个入口' });
    }
});

const historySearchSchema = z.object({ query: z.string().min(1).max(512), ...historyRange, cursor: historyCursor.optional(),
    limit: z.number().int().min(1).max(100).default(10), maxBytes: historyBudget,
    scanBytes: z.number().int().min(8192).max(1048576).default(131072) }).strict().superRefine((value, refinement) => {
    if (value.startRound !== undefined && value.endRound !== undefined && value.startRound > value.endRound) {
        refinement.addIssue({ code: 'custom', message: '起始轮不得晚于结束轮' });
    }
});

const historyHitSchema = z.object({ summaryId: z.string().min(1).max(256).optional(), roundHit: historyRound.optional() }).strict().superRefine((value, refinement) => {
    if ([value.summaryId, value.roundHit].filter(entry => entry !== undefined).length !== 1) {
        refinement.addIssue({ code: 'custom', message: '选择一个摘要或轮锚点标记有用命中' });
    }
});

export const localArgumentSchemas = {
    read_file: z.object({ path: filePath, offset: byteOffset.default(0), limit: z.number().int().min(1).max(262144).default(65536),
        encoding: z.enum(['utf8', 'base64']).default('utf8') }).strict(),
    write_file: z.object({ path: filePath, content: z.string().max(12 * 1024 * 1024),
        expectedVersion: z.string().regex(/^[a-f0-9]{64}$/), encoding: z.enum(['utf8', 'base64']).default('utf8') }).strict(),
    list_files: z.object({ path: filePath, limit: z.number().int().min(1).max(200).default(100), cursor: z.string().max(2048).optional() }).strict(),
    run_command: z.object({ application: filePath, args: z.array(z.string().max(32768)).max(256).default([]), cwd: filePath,
        stdin: z.string().max(16384).optional(), timeoutMs: z.number().int().min(100).max(3600000).default(30000),
        maxMemoryMB: z.number().int().min(16).max(4096).default(256), maxOutputBytes: z.number().int().min(1024).max(1048576).default(262144),
        writeSet: z.array(filePath).max(200).optional(), outputEncoding: z.enum(['auto', 'utf8', 'gb18030', 'utf16le']).optional() }).strict(),
    tool_catalog: z.object({ query: z.string().max(256).optional(), cursor: z.string().max(32).optional(),
        limit: z.number().int().min(1).max(100).default(24) }).strict(),
    tool_describe: z.object({ name: z.string().min(1).max(256) }).strict(),
    tool_load: z.object({ names: z.array(z.string().min(1).max(256)).min(1).max(32) }).strict(),
    history_read: historyReadSchema,
    history_search: historySearchSchema,
    mark_history_hit: historyHitSchema,
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
    { type: 'function', name: 'run_command', description: '执行普通程序及明确参数，工作目录和声明写集合须在获准工作区；遵守当前任务规则，不得读取控制凭据或修改控制文件。危险动作先交主调用方批准。Windows Job限制整树内存、超时和输出，取消或结束回收派生进程；命中本机禁止操作时暂停并停止自动重试。输出保留原始Base64及解码来源，候选编码按outputDecoding核对。PATH查询覆盖当前进程PATH，查询已安装环境可用tool_catalog(query=environment)发现sandbox_status。',
        parameters: { type: 'object', additionalProperties: false, required: ['application', 'cwd'], properties: {
            application: stringPath, args: { type: 'array', items: { type: 'string' }, maxItems: 256 }, cwd: stringPath,
            stdin: { type: 'string' }, timeoutMs: { type: 'integer', minimum: 100, maximum: 3600000 },
            maxMemoryMB: { type: 'integer', minimum: 16, maximum: 4096 }, maxOutputBytes: { type: 'integer', minimum: 1024, maximum: 1048576 },
            writeSet: { type: 'array', items: stringPath, maxItems: 200, description: '已知会修改的文件，未覆盖效果在回执中单列' },
            outputEncoding: { type: 'string', enum: ['auto', 'utf8', 'gb18030', 'utf16le'],
                description: 'auto先严格UTF-8，Windows旧编码作为候选并标明来源；已知程序编码时明确选择，原始Base64保留' },
        } } },
    { type: 'function', name: 'tool_catalog', description: '分页查找本任务可见的本地及共享MCP工具短目录；query按名称、服务、用途和中英别名匹配，无匹配时自动回退完整可见目录的有界页，沿nextCursor继续。不加载参数定义，也不调用外部模型。schema_pending表示已配置待核，按需tool_describe或tool_load核对，实际可发布选择见publication。',
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
    { type: 'function', name: 'history_read', description: '查回当前Core会话自身历史。按轮号与cursor分页读取原文，正文省略时用返回的contentId作为artifactId分片读取；看到read=summary:<id>时传summaryId="summary:<id>"展开完整摘要JSON，含正文、来源hash、序列、轮锚点和sourceSpans。摘要分片沿原summaryId与cursor继续，正文分片沿artifactId与offset继续。读取不增加有用命中，确实有用时再调用mark_history_hit。',
        parameters: { type: 'object', additionalProperties: false, properties: {
            summaryId: { type: 'string', minLength: 1, maxLength: 256 }, artifactId: { type: 'string', minLength: 1, maxLength: 256 },
            offset: { type: 'integer', minimum: 0 }, startRound: { type: 'integer', minimum: 1 }, endRound: { type: 'integer', minimum: 1 },
            cursor: { type: 'string', maxLength: 16384 }, limit: { type: 'integer', minimum: 1, maximum: 100 },
            maxBytes: { type: 'integer', minimum: 4096, maximum: 262144 }, direction: { type: 'string', enum: ['forward', 'backward'] },
        } } },
    { type: 'function', name: 'history_search', description: '在当前Core会话原文的canonical JSON中作字面搜索，返回来源itemId/contentId/hash/序列/轮锚点及可直接调用的history_read参数。每次只扫描有界分片，空结果且hasMore=true时用相同query、轮范围及nextCursor继续；complete仅覆盖固定历史水位。搜索不增加有用命中。',
        parameters: { type: 'object', additionalProperties: false, required: ['query'], properties: {
            query: { type: 'string', minLength: 1, maxLength: 512 }, startRound: { type: 'integer', minimum: 1 }, endRound: { type: 'integer', minimum: 1 },
            cursor: { type: 'string', maxLength: 16384 }, limit: { type: 'integer', minimum: 1, maximum: 100 },
            maxBytes: { type: 'integer', minimum: 4096, maximum: 262144 }, scanBytes: { type: 'integer', minimum: 8192, maximum: 1048576 },
        } } },
    { type: 'function', name: 'mark_history_hit', description: '明确标记刚查回的摘要或历史轮对当前任务确实有用，供下一次BPC发布调整保留程度。summaryId、roundHit（从1起的历史轮号）二选一，取自查回结果；只读取、看见或搜索匹配时不调用。会话、动作身份和反馈存储由可信Core绑定。',
        parameters: { type: 'object', additionalProperties: false, properties: {
            summaryId: { type: 'string', minLength: 1, maxLength: 256 }, roundHit: { type: 'integer', minimum: 1 },
        } } },
    ...FILE_OPERATION_SCHEMAS,
];
