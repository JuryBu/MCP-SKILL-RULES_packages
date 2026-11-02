import { immutableJson } from '../providers/assemble.js';
import type { NativeSendView, NormalizedResponse, ProviderAdapter, ToolResult } from '../providers/types.js';

export type NativeHistoryAdapter = Pick<ProviderAdapter, 'protocol' | 'continueView'> & {
    continueHistoryView?: ProviderAdapter['continueView'];
};

export function appendNativeHistoryView(adapter: NativeHistoryAdapter, view: NativeSendView,
    response: NormalizedResponse, results: ToolResult[]): NativeSendView {
    return adapter.continueHistoryView ? adapter.continueHistoryView(view, response, results) : adapter.continueView(view, response, results);
}

export function freezeNativeHistoryView(view: NativeSendView): NativeSendView {
    return immutableJson(view);
}
