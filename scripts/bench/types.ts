export type SeedFixture = { bankerId: string; username: string; password: string; sessionId: string; playerId: string; playerIds: string[]; token: string; counts: Record<string, number> };
export type HttpResult = { status: number; body: unknown; ms: number; serverMs: number | null; bytes: number; sha256?: string };
export type BenchmarkClient = { request: (path: string, options?: { method?: string; body?: unknown }) => Promise<HttpResult> };
export type Sample = { host?: { cores: number; otherCpu: number; threshold: number; noisyHost: boolean; serverCpu: number; browserCpu: number; controllerCpu: number | null }; recordedAt?: string; metric: string; ms: number; ok: boolean; status?: number; bytes?: number; sha256?: string; roundtripMs?: number; work: Record<string, string | number | boolean>; error?: string };
export type RecordSample = (sample: Sample) => void;
export type ApiOptions = { samples: number; reverse?: boolean; metrics?: Set<string> };
