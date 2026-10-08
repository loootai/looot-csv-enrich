// Minimal looot REST client. Plain fetch, no dependencies.
// Request shapes follow https://api.looot.ai/openapi.json.

export const DEFAULT_BASE_URL = "https://api.looot.ai";
export const TERMINAL = new Set(["completed", "failed", "blocked", "stopped"]);

export class LoootError extends Error {
  status: number;
  code: string;
  topUpUrl?: string;
  constructor(status: number, code: string, message: string, topUpUrl?: string) {
    super(message);
    this.name = "LoootError";
    this.status = status;
    this.code = code;
    this.topUpUrl = topUpUrl;
  }
}

export interface Run {
  runId: string;
  status: string;
  result?: unknown;
  normalized?: { fields?: Record<string, unknown> };
  actualCost?: number | null;
  route?: { servedBy?: string; chargedUsd?: number };
  error?: { code?: string; message?: string } | null;
  replayed?: boolean;
}

export interface FallbackOptions {
  maxAttempts: number;
  maxCostUsd: number;
}

export interface ClientOptions {
  token?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class Looot {
  baseUrl: string;
  token: string | undefined;
  #fetch: typeof fetch;
  #sleep: (ms: number) => Promise<void>;

  constructor(opts: ClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.LOOOT_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.token = (opts.token ?? process.env.LOOOT_TOKEN ?? "").trim() || undefined;
    this.#fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.#sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Free, no token: cheapest price per call for every job id in the catalog. */
  async jobPrices(): Promise<Map<string, { cheapestPerCall: number | null; providerCount: number }>> {
    type Job = { id: string; cheapestPerCall: number | null; providerCount: number };
    const data = await this.#request<{ categories?: { platforms?: { jobs?: Job[] }[] }[] }>(
      "GET", "/v1/catalog/overview", { query: { depth: "jobs" }, auth: false },
    );
    const out = new Map<string, { cheapestPerCall: number | null; providerCount: number }>();
    for (const cat of data.categories ?? []) {
      for (const p of cat.platforms ?? []) {
        for (const j of p.jobs ?? []) {
          const prev = out.get(j.id);
          if (!prev || (j.cheapestPerCall ?? Infinity) < (prev.cheapestPerCall ?? Infinity)) {
            out.set(j.id, { cheapestPerCall: j.cheapestPerCall, providerCount: j.providerCount });
          }
        }
      }
    }
    return out;
  }

  /** Free, needs a token with usage.read. */
  balance(): Promise<{ available: number; topUpUrl?: string | null }> {
    return this.#request("GET", "/v1/balance");
  }

  /**
   * Paid. Runs `job:<job>` with fallback across the job's providers, capped per call. The same
   * idempotency key with the same body returns the first run, so a rerun never pays twice.
   * Polls until the run is terminal or `timeoutMs` passes.
   */
  async runJob(job: string, input: Record<string, string>, idempotencyKey: string, fallback: FallbackOptions, timeoutMs = 120_000): Promise<Run> {
    let run = await this.#request<Run>("POST", "/v1/runs", {
      query: { wait: 30 },
      body: { endpointId: `job:${job}`, input, idempotencyKey, fallback: { enabled: true, ...fallback } },
    });
    const deadline = Date.now() + timeoutMs;
    while (!TERMINAL.has(run.status) && Date.now() < deadline) {
      await this.#sleep(2_000);
      run = await this.#request<Run>("GET", `/v1/runs/${encodeURIComponent(run.runId)}`);
    }
    return run;
  }

  async #request<T>(method: "GET" | "POST", path: string, opts: { query?: Record<string, string | number>; body?: unknown; auth?: boolean } = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { accept: "application/json" };
    if (opts.auth !== false) {
      if (!this.token) throw new LoootError(401, "missing_token", `${method} ${path} needs LOOOT_TOKEN`);
      headers.authorization = `Bearer ${this.token}`;
    }
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const res = await this.#fetch(url, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(75_000),
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const body = data as { error?: { code?: string; message?: string }; topUpUrl?: string } | null;
      throw new LoootError(res.status, body?.error?.code ?? `http_${res.status}`, body?.error?.message ?? `HTTP ${res.status}`, body?.topUpUrl);
    }
    return data as T;
  }
}
