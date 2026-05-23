import {
    HUMAN_VERIFICATION_KEYWORDS,
    HUMAN_VERIFICATION_THRESHOLD,
} from "./constants.js";

export type HumanVerificationStatus =
    | "normal"
    | "suspected_challenge"
    | "challenge_required"
    | "challenge_cleared_but_content_unavailable";

export type HumanVerificationConfidence = "none" | "weak" | "strong";

export interface HumanVerificationEvidence {
    type: "text" | "title" | "html" | "script" | "iframe" | "state" | "cookie";
    value: string;
}

export interface HumanVerificationDetectionInput {
    url: string;
    title?: string;
    visibleText?: string;
    frameText?: string;
    html?: string;
    scriptUrls?: string[];
    iframeUrls?: string[];
    waitForMatched?: boolean;
    hasCookieForDomain?: boolean;
}

export interface HumanVerificationDetection {
    status: HumanVerificationStatus;
    confidence: HumanVerificationConfidence;
    reasonCodes: string[];
    evidence: HumanVerificationEvidence[];
    hasUsableContent: boolean;
    hasCookieForDomain: boolean;
    shouldOfferUav: boolean;
    matchedKeyword?: string;
}

interface StrongSignature {
    code: string;
    pattern: RegExp;
    evidenceType: HumanVerificationEvidence["type"];
}

const STRONG_SIGNATURES: StrongSignature[] = [
    {
        code: "cloudflare-challenge-platform",
        pattern: /\/cdn-cgi\/challenge-platform\//i,
        evidenceType: "html",
    },
    {
        code: "cloudflare-turnstile-script",
        pattern: /challenges\.cloudflare\.com\/turnstile/i,
        evidenceType: "script",
    },
    {
        code: "cloudflare-challenge-token",
        pattern: /\bcf-chl-|__cf_chl_|cf_chl_/i,
        evidenceType: "html",
    },
    {
        code: "cloudflare-clearance-flow",
        pattern: /\bcf_clearance\b/i,
        evidenceType: "html",
    },
    {
        code: "turnstile-widget",
        pattern: /\bcf-turnstile\b|data-cf-turnstile|turnstile-widget/i,
        evidenceType: "html",
    },
    {
        code: "google-recaptcha",
        pattern: /(?:www\.google\.com|www\.recaptcha\.net)\/recaptcha|g-recaptcha\b/i,
        evidenceType: "html",
    },
    {
        code: "hcaptcha",
        pattern: /(?:js\.|newassets\.)?hcaptcha\.com\/(?:1\/api\.js|captcha)|\bh-captcha\b|data-hcaptcha/i,
        evidenceType: "html",
    },
];

const STRONG_WAITING_TEXTS = [
    "请稍候",
    "just a moment",
    "checking your browser",
    "checking if the site connection is secure",
    "enable javascript and cookies",
];

const CHALLENGE_ONLY_TEXTS = [
    ...STRONG_WAITING_TEXTS,
    "验证成功",
    "正在等待",
    "找不到页面",
    "please wait while we verify",
    "needs to review the security of your connection",
];

export function detectHumanVerificationSignals(input: HumanVerificationDetectionInput): HumanVerificationDetection {
    const title = normalizeText(input.title);
    const visibleText = normalizeText(input.visibleText);
    const frameText = normalizeText(input.frameText);
    const html = input.html ?? "";
    const scriptUrls = input.scriptUrls ?? [];
    const iframeUrls = input.iframeUrls ?? [];
    const hasCookieForDomain = input.hasCookieForDomain ?? false;
    const combinedText = normalizeText(`${title} ${visibleText} ${frameText}`);
    const lowerText = combinedText.toLowerCase();
    const textLength = normalizeText(`${visibleText} ${frameText}`).length;
    const hasUsableContent = Boolean(input.waitForMatched) || hasBusinessContent(visibleText, frameText);

    const reasonCodes: string[] = [];
    const evidence: HumanVerificationEvidence[] = [];

    for (const signature of STRONG_SIGNATURES) {
        const matched = findSignatureEvidence(signature, html, scriptUrls, iframeUrls);
        if (matched) {
            pushUnique(reasonCodes, signature.code);
            evidence.push({
                type: matched.type,
                value: truncateEvidence(matched.value),
            });
        }
    }

    const waitingText = STRONG_WAITING_TEXTS.find(text => lowerText.includes(text));
    if (waitingText && textLength < HUMAN_VERIFICATION_THRESHOLD) {
        pushUnique(reasonCodes, "challenge-waiting-text");
        evidence.push({
            type: title.toLowerCase().includes(waitingText) ? "title" : "text",
            value: waitingText,
        });
    }

    let matchedKeyword: string | undefined;
    if (textLength < HUMAN_VERIFICATION_THRESHOLD) {
        matchedKeyword = HUMAN_VERIFICATION_KEYWORDS.find(keyword =>
            lowerText.includes(keyword.toLowerCase())
        );
        if (matchedKeyword) {
            pushUnique(reasonCodes, "human-verification-keyword");
            evidence.push({
                type: "text",
                value: matchedKeyword,
            });
        }
    }

    const hasStrongSignal = reasonCodes.some(code => code !== "human-verification-keyword");
    const hasAnySignal = reasonCodes.length > 0;

    if (!hasAnySignal) {
        return {
            status: "normal",
            confidence: "none",
            reasonCodes,
            evidence,
            hasUsableContent,
            hasCookieForDomain,
            shouldOfferUav: false,
        };
    }

    const challengeOnlyContent = hasStrongSignal && isChallengeOnlyContent(lowerText);
    const effectiveHasUsableContent = hasUsableContent && !challengeOnlyContent;

    if (effectiveHasUsableContent) {
        evidence.push({ type: "state", value: "usable-content-present" });
        return {
            status: "suspected_challenge",
            confidence: hasStrongSignal ? "weak" : "none",
            reasonCodes,
            evidence,
            hasUsableContent: effectiveHasUsableContent,
            hasCookieForDomain,
            shouldOfferUav: false,
            matchedKeyword,
        };
    }

    if (hasStrongSignal) {
        return {
            status: "challenge_required",
            confidence: "strong",
            reasonCodes,
            evidence,
            hasUsableContent: effectiveHasUsableContent,
            hasCookieForDomain,
            shouldOfferUav: true,
            matchedKeyword,
        };
    }

    if (matchedKeyword) {
        if (hasCookieForDomain) {
            evidence.push({ type: "cookie", value: "cookie-present-weak-signal-observe" });
            return {
                status: "suspected_challenge",
                confidence: "weak",
                reasonCodes,
                evidence,
                hasUsableContent: effectiveHasUsableContent,
                hasCookieForDomain,
                shouldOfferUav: false,
                matchedKeyword,
            };
        }

        return {
            status: "challenge_required",
            confidence: "weak",
            reasonCodes,
            evidence,
            hasUsableContent: effectiveHasUsableContent,
            hasCookieForDomain,
            shouldOfferUav: true,
            matchedKeyword,
        };
    }

    return {
        status: "normal",
        confidence: "none",
        reasonCodes,
        evidence,
        hasUsableContent,
        hasCookieForDomain,
        shouldOfferUav: false,
    };
}

export function formatHumanVerificationDetection(detection: HumanVerificationDetection): string {
    if (detection.status === "normal") return "normal";
    const reasons = detection.reasonCodes.join(",") || "unknown";
    const cookie = detection.hasCookieForDomain ? "cookie=present" : "cookie=none";
    const usable = detection.hasUsableContent ? "usable=true" : "usable=false";
    return `${detection.status} confidence=${detection.confidence} reasons=${reasons} ${cookie} ${usable}`;
}

function normalizeText(text?: string): string {
    return (text ?? "").replace(/[\n\r\t]+/g, " ").replace(/\s+/g, " ").trim();
}

function hasBusinessContent(visibleText: string, frameText: string): boolean {
    const text = normalizeText(`${visibleText} ${frameText}`);
    if (text.length >= HUMAN_VERIFICATION_THRESHOLD) return true;
    if (text.length < 120) return false;
    const lower = text.toLowerCase();
    const waitingOnly = STRONG_WAITING_TEXTS.some(waiting => lower.includes(waiting));
    return !waitingOnly;
}

function isChallengeOnlyContent(lowerText: string): boolean {
    return CHALLENGE_ONLY_TEXTS.some(text => lowerText.includes(text));
}

function findSignatureEvidence(
    signature: StrongSignature,
    html: string,
    scriptUrls: string[],
    iframeUrls: string[],
): { type: HumanVerificationEvidence["type"]; value: string } | null {
    if (signature.pattern.test(html)) {
        return { type: signature.evidenceType, value: extractMatchContext(html, signature.pattern) };
    }

    const script = scriptUrls.find(url => signature.pattern.test(url));
    if (script) return { type: "script", value: script };

    const iframe = iframeUrls.find(url => signature.pattern.test(url));
    if (iframe) return { type: "iframe", value: iframe };

    return null;
}

function extractMatchContext(text: string, pattern: RegExp): string {
    const match = pattern.exec(text);
    if (!match || match.index < 0) return "";
    const start = Math.max(0, match.index - 60);
    const end = Math.min(text.length, match.index + match[0].length + 60);
    return text.slice(start, end);
}

function truncateEvidence(value: string): string {
    const normalized = normalizeText(value);
    return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
}

function pushUnique(values: string[], value: string): void {
    if (!values.includes(value)) values.push(value);
}
