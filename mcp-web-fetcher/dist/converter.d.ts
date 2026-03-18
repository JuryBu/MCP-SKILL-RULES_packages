/**
 * 文档格式转换器
 * - 自动检测系统上可用的转换工具（LibreOffice / xelatex / pdflatex）
 * - 将 DOCX/PPTX/XLSX/TEX 等文件转换为 PDF
 * - 带缓存命中机制
 */
interface ConverterTools {
    libreoffice?: string;
    xelatex?: string;
    pdflatex?: string;
}
/**
 * 检测系统上可用的转换工具
 */
export declare function detectConversionTools(): Promise<ConverterTools>;
/**
 * 判断文件类型
 */
export type FileCategory = "pdf" | "html" | "image" | "video" | "office" | "tex" | "text" | "unknown";
export declare function categorizeFile(filePath: string): FileCategory;
/**
 * 将文件转换为 PDF（带缓存）
 * @returns 临时 PDF 文件路径
 */
export declare function convertToPDF(filePath: string): Promise<string>;
/**
 * 将 xlsx 文件转换为 CSV 文本摘要
 * 使用 Node.js 简单解析（不依赖外部库），读取前 N 行
 */
export declare function xlsxToTextSummary(filePath: string): Promise<string>;
export {};
//# sourceMappingURL=converter.d.ts.map