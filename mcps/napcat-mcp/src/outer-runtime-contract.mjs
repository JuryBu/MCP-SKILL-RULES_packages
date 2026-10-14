export class CodexAppServerProxyError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "CodexAppServerProxyError";
    this.code = code;
    this.outcomeUnknown = Boolean(options.outcomeUnknown);
    this.details = options.details ?? null;
  }
}
