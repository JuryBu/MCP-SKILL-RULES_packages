export type AntigravityTransport = 'app-ls' | 'legacy-ls' | 'cli-ls' | 'cli-agent';

export type AntigravityOutcome =
  | 'success'
  | 'not-started'
  | 'unsupported'
  | 'rejected'
  | 'auth-required'
  | 'quota-exhausted'
  | 'cancelled'
  | 'timeout-unknown'
  | 'transport-unknown'
  | 'invalid-response';

export interface AntigravityRequest {
  prompt: string;
  purpose?: 'material' | 'visual-review';
  model?: string;
  imagePaths?: string[];
  schema?: Record<string, unknown>;
  generationTimeoutMs?: number;
  deadline: number;
  signal?: AbortSignal;
  onSubmitted?: (model?: string) => void;
}

export interface AntigravityCleanup {
  status: 'graceful' | 'abnormal-exit' | 'terminated' | 'unconfirmed';
  confirmed: boolean;
  method: 'already-exited' | 'stdin-eof' | 'owned-tree-terminate';
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  unexpectedExit: boolean;
  eofWaitMs: number;
  elapsedMs: number;
  fault?: { outcome: AntigravityOutcome; error: string };
  tempRemoved?: boolean;
  warnings: string[];
}

export interface AntigravityResult {
  text: string | null;
  transport: AntigravityTransport | null;
  model: string | null;
  outcome: AntigravityOutcome;
  submitted: boolean;
  safeToFallback: boolean;
  error?: string;
  cleanup?: AntigravityCleanup;
}

export interface AntigravityEndpoint {
  host: '127.0.0.1';
  port: number;
  csrfToken?: string;
  useHttps?: boolean;
  pid: number;
  identity: string;
  transport: 'app-ls' | 'legacy-ls' | 'cli-ls';
}

export interface AntigravityModel {
  id: string;
  label: string;
  modelId?: string;
  disabled: boolean;
  supportsImages: boolean;
  family?: string;
  quotaRemaining?: number;
  description?: string;
}

export interface AntigravityCatalog {
  models: AntigravityModel[];
  modern: boolean;
  accountKey?: string;
  tier?: string;
}

export interface AntigravitySelection {
  model?: AntigravityModel;
  error?: AntigravityResult;
}

export function remainingAntigravityMs(request: Pick<AntigravityRequest, 'deadline'>): number {
  const remaining = request.deadline - performance.now();
  return Number.isFinite(remaining) ? Math.max(0, remaining) : 0;
}

export function antigravityFailure(
  outcome: AntigravityOutcome,
  error: string,
  transport: AntigravityTransport | null = null,
  model: string | null = null,
  submitted = false,
  safeToFallback = false,
): AntigravityResult {
  return { text: null, transport, model, outcome, submitted, safeToFallback, error };
}
