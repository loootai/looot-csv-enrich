// A fake looot API for tests. No network, no money.

export interface Call {
  method: string;
  path: string;
  body: any;
  auth: string | null;
}

export type Handler = (call: Call) => { status?: number; body: unknown } | undefined;

export const OVERVIEW = {
  categories: [{
    platforms: [{
      jobs: [
        { id: "company.enrich", cheapestPerCall: 0.002, providerCount: 21 },
        { id: "people.email.find", cheapestPerCall: 0.004, providerCount: 17 },
        { id: "people.email.verify", cheapestPerCall: 0.0015, providerCount: 13 },
        { id: "people.phone.find", cheapestPerCall: 0.005, providerCount: 12 },
        { id: "people.enrich.by-email", cheapestPerCall: 0.004, providerCount: 10 },
      ],
    }],
  }],
};

/** Returns a fetch stand-in plus the list of calls it saw. Unhandled POST /v1/runs is a 500. */
export function fakeFetch(handler: Handler): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: Call = {
      method: init?.method ?? "GET",
      path: url.pathname + url.search,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: headers.authorization ?? null,
    };
    calls.push(call);
    let out = handler(call);
    if (!out && url.pathname === "/v1/catalog/overview") out = { body: OVERVIEW };
    if (!out) out = { status: 500, body: { error: { code: "unhandled", message: call.path } } };
    return new Response(JSON.stringify(out.body), { status: out.status ?? 200, headers: { "content-type": "application/json" } });
  };
  return { fetch: f as typeof fetch, calls };
}
