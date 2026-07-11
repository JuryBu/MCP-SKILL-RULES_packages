export type CallErrorKind =
    | "rate_limit"
    | "server_error"
    | "timeout"
    | "network"
    | "cancelled"
    | "empty_output"
    | "content_truncated"
    | "unknown";

export type CallOutcome = {
    success: boolean;
    errorKind?: CallErrorKind;
};
