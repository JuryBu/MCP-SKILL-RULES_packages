/**
 * Symbol Index — tree-sitter AST 符号提取 + 索引缓存
 *
 * 使用 web-tree-sitter (Wasm) 解析代码文件，提取深层符号（函数、类、方法、类型等）。
 * 支持惰性加载语言 grammar，mtime 增量更新缓存。
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// 类型从模块声明中提取
import type WTS from "web-tree-sitter";
type SyntaxNode = WTS.Node;
type Language = WTS.Language;
type Tree = WTS.Tree;

// web-tree-sitter 惰性加载（ESM 动态 import）
// v0.26+ 使用命名导出：{ Parser, Language, ... }
// Parser.init() 初始化 WASM，new Parser() 创建实例
let _ParserClass: any = null;
let _LanguageClass: any = null;

async function getTreeSitter(): Promise<{ Parser: any; Language: any }> {
    if (_ParserClass) return { Parser: _ParserClass, Language: _LanguageClass };
    const mod = await import("web-tree-sitter");
    _ParserClass = mod.Parser;
    _LanguageClass = mod.Language;
    return { Parser: _ParserClass, Language: _LanguageClass };
}

// ===== 类型 =====

export interface SymbolInfo {
    name: string;       // 符号名，深层符号带父级路径如 "Foo.bar"
    type: string;       // "func" | "class" | "method" | "type" | "interface" | "enum" | "const" | "field" | "var"
    line: number;       // 起始行号 (1-indexed)
    endLine: number;    // 结束行号
    parent?: string;    // 父符号名
}

export interface FileIndex {
    mtime: number;
    size: number;
    language: string;
    symbols: SymbolInfo[];
    headerComment: string;    // 文件头 5-10 行
}

// ===== 语言映射 =====

const LANG_MAP: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "tsx",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".py": "python",
};

const WASM_FILES: Record<string, string> = {
    "typescript": "tree-sitter-typescript.wasm",
    "tsx": "tree-sitter-tsx.wasm",
    "javascript": "tree-sitter-javascript.wasm",
    "python": "tree-sitter-python.wasm",
};

// ===== 模块状态 =====

let parserReady = false;
const loadedLanguages = new Map<string, Language>(); // searchPath → fileMap
const indexCache = new Map<string, Map<string, FileIndex>>(); // searchPath → fileMap

// ===== 初始化 =====

let initPromise: Promise<void> | null = null;

async function ensureParserInit(): Promise<void> {
    if (parserReady) return;
    if (initPromise) return initPromise;

    initPromise = (async () => {
        const { Parser } = await getTreeSitter();
        const __dirname = path.dirname(fileURLToPath(import.meta.url));
        const wasmPath = path.join(__dirname, "..", "node_modules", "web-tree-sitter", "web-tree-sitter.wasm");
        await Parser.init({
            locateFile: () => wasmPath,
        });
        parserReady = true;
    })();
    return initPromise;
}

async function loadLanguage(lang: string): Promise<Language | null> {
    if (loadedLanguages.has(lang)) return loadedLanguages.get(lang)!;

    await ensureParserInit();

    const wasmFile = WASM_FILES[lang];
    if (!wasmFile) return null;

    // grammars 目录在项目根
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const grammarsDir = path.join(__dirname, "..", "grammars");
    const wasmPath = path.join(grammarsDir, wasmFile);

    if (!fs.existsSync(wasmPath)) {
        console.error(`[symbol-index] Grammar 文件不存在: ${wasmPath}`);
        return null;
    }

    try {
        const { Language: LangClass } = await getTreeSitter();
        const language = await LangClass.load(wasmPath);
        loadedLanguages.set(lang, language);
        return language;
    } catch (err) {
        console.error(`[symbol-index] 加载 ${lang} grammar 失败:`, err);
        return null;
    }
}

// ===== AST 符号提取 =====

function extractSymbolsFromTree(tree: Tree, lang: string): SymbolInfo[] {
    const symbols: SymbolInfo[] = [];
    const cursor = tree.walk();

    function visit(parentName?: string): void {
        const node = cursor.currentNode;
        let sym: SymbolInfo | null = null;

        if (lang === "typescript" || lang === "tsx" || lang === "javascript") {
            sym = extractTsSymbol(node, parentName);
        } else if (lang === "python") {
            sym = extractPySymbol(node, parentName);
        }

        if (sym) {
            symbols.push(sym);
            // 深入子节点查找嵌套符号
            if (cursor.gotoFirstChild()) {
                do { visit(sym.name); } while (cursor.gotoNextSibling());
                cursor.gotoParent();
            }
        } else {
            // 非符号节点也继续遍历
            if (cursor.gotoFirstChild()) {
                do { visit(parentName); } while (cursor.gotoNextSibling());
                cursor.gotoParent();
            }
        }
    }

    if (cursor.gotoFirstChild()) {
        do { visit(); } while (cursor.gotoNextSibling());
    }

    return symbols;
}

function extractTsSymbol(node: SyntaxNode, parentName?: string): SymbolInfo | null {
    const type = node.type;
    let name: string | null = null;
    let symType = "";

    switch (type) {
        case "function_declaration":
        case "generator_function_declaration":
            name = node.childForFieldName("name")?.text ?? null;
            symType = "func";
            break;
        case "class_declaration":
            name = node.childForFieldName("name")?.text ?? null;
            symType = "class";
            break;
        case "interface_declaration":
            name = node.childForFieldName("name")?.text ?? null;
            symType = "interface";
            break;
        case "type_alias_declaration":
            name = node.childForFieldName("name")?.text ?? null;
            symType = "type";
            break;
        case "enum_declaration":
            name = node.childForFieldName("name")?.text ?? null;
            symType = "enum";
            break;
        case "method_definition":
            name = node.childForFieldName("name")?.text ?? null;
            symType = "method";
            break;
        case "public_field_definition":
        case "property_definition":
            name = node.childForFieldName("name")?.text ?? null;
            symType = "field";
            break;
        case "lexical_declaration": {
            // const/let/var — 提取变量名（可能包括箭头函数）
            const declarator = node.namedChildren.find((c: SyntaxNode) => c.type === "variable_declarator");
            if (declarator) {
                name = declarator.childForFieldName("name")?.text ?? null;
                const value = declarator.childForFieldName("value");
                if (value && (value.type === "arrow_function" || value.type === "function_expression")) {
                    symType = "func";
                } else {
                    symType = "const";
                }
            }
            break;
        }
        case "export_statement": {
            // export default / export const 等 — 委托给子节点
            return null; // 让 visit() 自然递归进子节点
        }
    }

    if (!name) return null;
    const fullName = parentName ? `${parentName}.${name}` : name;

    return {
        name: fullName,
        type: symType,
        line: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        parent: parentName,
    };
}

function extractPySymbol(node: SyntaxNode, parentName?: string): SymbolInfo | null {
    const type = node.type;
    let name: string | null = null;
    let symType = "";

    switch (type) {
        case "function_definition":
            name = node.childForFieldName("name")?.text ?? null;
            symType = parentName ? "method" : "func";
            break;
        case "class_definition":
            name = node.childForFieldName("name")?.text ?? null;
            symType = "class";
            break;
        case "decorated_definition": {
            // 装饰器 — 提取被装饰的定义
            const def = node.namedChildren.find((c: SyntaxNode) =>
                c.type === "function_definition" || c.type === "class_definition"
            );
            if (def) return extractPySymbol(def, parentName);
            return null;
        }
    }

    if (!name) return null;
    const fullName = parentName ? `${parentName}.${name}` : name;

    return {
        name: fullName,
        type: symType,
        line: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        parent: parentName,
    };
}

// ===== 文件头注释提取 =====

function extractHeader(content: string, lines = 10): string {
    return content.split("\n").slice(0, lines).join("\n");
}

// ===== 单文件索引 =====

async function indexFile(filePath: string): Promise<FileIndex | null> {
    const ext = path.extname(filePath).toLowerCase();
    const lang = LANG_MAP[ext];
    if (!lang) return null;

    let stat;
    try { stat = fs.statSync(filePath); } catch { return null; }

    const language = await loadLanguage(lang);
    if (!language) {
        // 不支持的语言：用正则兜底
        return indexFileWithRegex(filePath, stat);
    }

    let content;
    try { content = fs.readFileSync(filePath, "utf-8"); } catch { return null; }

    const { Parser } = await getTreeSitter();
    const parser = new Parser();
    parser.setLanguage(language);

    const tree = parser.parse(content);
    if (!tree) { parser.delete(); return null; }
    const symbols = extractSymbolsFromTree(tree, lang);
    tree.delete();
    parser.delete();

    return {
        mtime: stat.mtimeMs,
        size: stat.size,
        language: lang,
        symbols,
        headerComment: extractHeader(content),
    };
}

// ===== 正则兜底（不支持的语言） =====

const GENERIC_PATTERNS = [
    { re: /(?:export\s+)?(?:async\s+)?(?:function|func|fn|def|sub|proc)\s+(\w+)/g, type: "func" },
    { re: /(?:export\s+)?(?:class|struct|enum|interface|trait|type)\s+(\w+)/g, type: "class" },
];

function indexFileWithRegex(filePath: string, stat: fs.Stats): FileIndex | null {
    let content;
    try { content = fs.readFileSync(filePath, "utf-8"); } catch { return null; }

    const symbols: SymbolInfo[] = [];
    for (const { re, type } of GENERIC_PATTERNS) {
        re.lastIndex = 0;
        let match;
        while ((match = re.exec(content)) !== null) {
            const line = content.substring(0, match.index).split("\n").length;
            symbols.push({ name: match[1], type, line, endLine: line });
        }
    }

    return {
        mtime: stat.mtimeMs,
        size: stat.size,
        language: "unknown",
        symbols,
        headerComment: extractHeader(content),
    };
}

// ===== 目录扫描 + 缓存 =====

interface ScanOptions {
    includes?: string[];
    excludes?: string[];
}

const DEFAULT_EXCLUDES = [
    "node_modules", "dist", ".git", "__pycache__",
    ".next", ".nuxt", "build", "out", ".cache",
    "vendor", "target", ".tox",
];

function shouldExclude(name: string, excludes: string[]): boolean {
    return excludes.some(e => {
        if (e === name) return true;
        // 安全的 glob 匹配：仅支持 * 通配符，转义其他正则特殊字符
        try {
            const escaped = e.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
            return new RegExp(`^${escaped}$`).test(name);
        } catch { return false; }
    });
}

function matchesInclude(filePath: string, includes?: string[]): boolean {
    if (!includes || includes.length === 0) return true;
    const ext = path.extname(filePath);
    return includes.some(pattern => {
        if (pattern.startsWith("*.")) return ext === pattern.substring(1);
        return filePath.includes(pattern);
    });
}

function collectFiles(dir: string, opts: ScanOptions, result: string[]): void {
    const excludes = opts.excludes || DEFAULT_EXCLUDES;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
        if (shouldExclude(entry.name, excludes)) continue;

        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            collectFiles(fullPath, opts, result);
        } else if (entry.isFile() && matchesInclude(fullPath, opts.includes)) {
            // 只收集有语言映射的文件，或者 includes 里明确指定的
            const ext = path.extname(entry.name).toLowerCase();
            if (LANG_MAP[ext] || matchesInclude(fullPath, opts.includes)) {
                result.push(fullPath);
            }
        }
    }
}

/**
 * 扫描目录，返回所有文件的符号索引。
 * 使用 mtime 增量缓存，文件没变就不重新解析。
 * 多文件并行解析。
 */
export async function scanDirectory(
    searchPath: string,
    opts: ScanOptions = {}
): Promise<Map<string, FileIndex>> {
    // 获取或创建缓存
    const cacheKey = searchPath;
    if (!indexCache.has(cacheKey)) {
        indexCache.set(cacheKey, new Map());
    }
    const cache = indexCache.get(cacheKey)!;

    // 收集文件
    const files: string[] = [];
    collectFiles(searchPath, opts, files);

    // 并行索引（增量更新）
    const BATCH_SIZE = 20;
    const newCache = new Map<string, FileIndex>();

    for (let i = 0; i < files.length; i += BATCH_SIZE) {
        const batch = files.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(batch.map(async (filePath) => {
            // 检查缓存
            const cached = cache.get(filePath);
            if (cached) {
                try {
                    const stat = fs.statSync(filePath);
                    if (stat.mtimeMs === cached.mtime) {
                        return { path: filePath, index: cached };
                    }
                } catch { /* 文件可能被删除 */ }
            }

            // 需要重新索引
            const index = await indexFile(filePath);
            return index ? { path: filePath, index } : null;
        }));

        for (const result of results) {
            if (result) newCache.set(result.path, result.index);
        }
    }

    // 更新缓存
    indexCache.set(cacheKey, newCache);
    return newCache;
}

/**
 * 获取所有符号的扁平列表（用于 fuse.js）
 */
export function flattenSymbols(index: Map<string, FileIndex>): Array<SymbolInfo & { file: string }> {
    const result: Array<SymbolInfo & { file: string }> = [];
    for (const [file, fileIndex] of index) {
        for (const sym of fileIndex.symbols) {
            result.push({ ...sym, file });
        }
    }
    return result;
}

export interface FunctionBound {
    name: string;
    type: string;
    filePath: string;
    startLine: number;
    endLine: number;
}

export function flattenFunctionBounds(index: Map<string, FileIndex>): FunctionBound[] {
    const result: FunctionBound[] = [];
    for (const [filePath, fileIndex] of index) {
        for (const sym of fileIndex.symbols) {
            if (!["func", "method", "class"].includes(sym.type)) continue;
            result.push({
                name: sym.name,
                type: sym.type,
                filePath,
                startLine: sym.line,
                endLine: Math.max(sym.endLine, sym.line),
            });
        }
    }
    return result;
}

/**
 * 清除缓存
 */
export function clearCache(searchPath?: string): void {
    if (searchPath) {
        indexCache.delete(searchPath);
    } else {
        indexCache.clear();
    }
}
