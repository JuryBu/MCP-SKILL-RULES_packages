/**
 * 为指定目录启动 HTTP 服务器
 * 同一目录复用已有服务器实例
 */
export declare function serveDirectory(rootDir: string): Promise<{
    url: string;
    port: number;
}>;
/**
 * 关闭指定目录的服务器
 */
export declare function stopServer(rootDir: string): void;
/**
 * 关闭所有活跃的服务器
 */
export declare function stopAllServers(): void;
/**
 * 检查 HTML 文件是否属于多文件项目（同目录下有 .js/.css/.json 等关联文件）
 */
export declare function isMultiFileProject(htmlFilePath: string): boolean;
//# sourceMappingURL=local-server.d.ts.map