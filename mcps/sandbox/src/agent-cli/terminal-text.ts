import { eastAsianCharacterWidth, type AmbiguousWidth } from './configuration-width.js';

export interface TerminalTextMetrics {
    ambiguousWidth?: AmbiguousWidth;
    characterWidths?: Readonly<Record<string, number>>;
}

export type TerminalTextWidth = AmbiguousWidth | TerminalTextMetrics;

export function characterCellWidth(text: string, metrics: TerminalTextWidth = 'narrow'): number {
    if (!text) return 0;
    if (/^[\p{Mark}\u200d\ufe00-\ufe0f]+$/u.test(text)) return 0;
    const measured = typeof metrics === 'object' ? metrics.characterWidths?.[text] : undefined;
    if (measured === 1 || measured === 2) return measured;
    if (/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(text)) return 2;
    const ambiguousWidth = typeof metrics === 'string' ? metrics : metrics.ambiguousWidth;
    return eastAsianCharacterWidth(text.codePointAt(0) ?? 0, ambiguousWidth);
}
