export function validateAutoSummaryCandidate(text: string): string | null {
    const trimmed = text.trim();
    if (!trimmed) return "empty-response";
    const unwrapped = trimmed.replace(/^```(?:json|text)?\s*\n([\s\S]*?)\n```$/iu, "$1").trim();
    try {
        const value: unknown = JSON.parse(unwrapped);
        if (value && typeof value === "object" && !Array.isArray(value)) {
            const fields = Object.keys(value);
            if ((fields.some(key => /^(?:error|errors|error_code)$/iu.test(key)) || /^(?:error|failed)$/iu.test(String((value as Record<string, unknown>).status || "")))
                && fields.every(key => /^(?:error|errors|error_code|code|status|message|detail|details|request_id|type)$/iu.test(key))) {
                return "service-error-envelope";
            }
            if (fields.length === 1 && /^(?:response|text|message)$/iu.test(fields[0])) {
                const wrapped = (value as Record<string, unknown>)[fields[0]];
                if (typeof wrapped === "string" && validateAutoSummaryCandidate(wrapped)) return "service-error-envelope";
            }
        }
    } catch {}
    const normalized = unwrapped.replace(/\s+/gu, " ");
    const narrative = /(?:\b(?:investigated|resolved|fixed|diagnosed|implemented|tested|discussed|summarizes|describes|records|explains)\b|已(?:修复|排查|验证|完成)|根因(?:是|为)|讨论了|记录了|分析了|排查.*(?:发现|确认)|通过测试)/iu.test(normalized);
    if (/^(?:notice:\s*)?(?:the\s+)?[\w .()+/\-]{1,120}\s+(?:is no longer available|has been (?:retired|deprecated|disabled)|is (?:deprecated|discontinued))\.?\s*(?:(?:please|kindly)\s+(?:switch|upgrade|update|use|select)\b[^\n]*)?$/iu.test(normalized)) {
        if (!narrative) return "service-retirement-notice";
    }
    if (/^(?:error(?:\s+\d{3})?|http\s+[45]\d{2}|(?:api|server|service|upstream|request|model)\s+(?:error|unavailable|overloaded|failed))\s*[:：-]\s*[^\n]+$/iu.test(normalized)
        && !narrative) {
        return "service-error-response";
    }
    if (/^(?:(?:该|当前)(?:模型|服务)(?:已|现已)?(?:停用|下线|不可用)|服务(?:已|现已)?(?:停用|不可用)|(?:请求|模型调用|摘要生成|生成)失败|服务错误|错误)\s*[:：]\s*[^\n]+$/u.test(normalized)
        && !narrative) {
        return "service-error-response";
    }
    if (/^(?:unauthorized|forbidden|invalid api key|too many requests|rate limit exceeded|internal server error|service unavailable)[.!]?$/iu.test(normalized)) return "service-error-response";
    return null;
}
