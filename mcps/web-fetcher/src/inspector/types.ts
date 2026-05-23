export type InspectSource = "dom" | "pdf" | "pptx" | "ebook";

export type InspectIssueSeverity = "info" | "warning" | "error";

export type InspectIssueType =
    | "overlap"
    | "overflow"
    | "clipped"
    | "small-font"
    | "low-contrast"
    | "misalignment"
    | "inconsistent-size"
    | "uneven-spacing"
    | "hidden"
    | "ai-finding"
    | (string & {});

export type InspectElementType =
    | "text"
    | "image"
    | "shape"
    | "link"
    | "table"
    | "group"
    | "container"
    | "unknown"
    | (string & {});

export interface Rect {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

export type InspectMetadataValue =
    | string
    | number
    | boolean
    | null
    | InspectMetadataValue[]
    | { [key: string]: InspectMetadataValue };

export interface InspectElement {
    type: InspectElementType;
    name: string;
    text: string;
    bounds: Rect;
    zOrder: number;
    fontSize?: number;
    color?: string;
    opacity?: number;
    source?: InspectSource;
    id?: string;
    role?: string;
    className?: string;
    page?: number;
    metadata?: Record<string, InspectMetadataValue>;
}

export interface PageDimensions {
    width: number;
    height: number;
    unit?: string;
}

export interface PageStructure {
    page: number;
    dimensions: PageDimensions;
    elements: InspectElement[];
    source?: InspectSource;
    metadata?: Record<string, InspectMetadataValue>;
}

export interface InspectIssue {
    type: InspectIssueType;
    severity: InspectIssueSeverity;
    page: number;
    description: string;
    elements: InspectElement[];
    screenshotPath?: string;
    bounds?: Rect;
    metadata?: Record<string, InspectMetadataValue>;
}

export interface InspectSummary {
    pages: number;
    elements: number;
    issues: number;
    warnings: number;
    errors: number;
}

export interface InspectResult {
    summary: InspectSummary;
    issues: InspectIssue[];
    structure?: PageStructure[];
}

export interface AIReviewFinding {
    page: number;
    severity: InspectIssueSeverity;
    category: string;
    description: string;
    suggestion?: string;
    bounds?: Rect;
    elements?: InspectElement[];
    metadata?: Record<string, InspectMetadataValue>;
}

export interface AIReviewReport {
    summary: string;
    aiFindings: AIReviewFinding[];
    confirmedIssues: string[];
    dismissedIssues: string[];
    dismissReason: Record<string, string>;
    reportPath?: string;
    chainUsed?: string | null;
    providerLabel?: string | null;
    error?: string;
    rawResponse?: string;
}
