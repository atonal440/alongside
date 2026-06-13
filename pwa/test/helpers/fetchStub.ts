export interface RecordedCall {
  path: string;
  method: string;
  body: unknown;
}

type ResponseSpec =
  | { type: 'json'; status: number; body: unknown }
  | { type: 'network-error' };

interface Matcher {
  method?: string;
  path?: string;
}

interface QueuedResponse {
  matcher: Matcher;
  spec: ResponseSpec;
}

export interface FetchStub {
  respondWith(matcher: Matcher, spec: ResponseSpec): void;
  networkError(matcher?: Matcher): void;
  calls: RecordedCall[];
  restore(): void;
}

export function installFetchStub(): FetchStub {
  const queue: QueuedResponse[] = [];
  const calls: RecordedCall[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    let body: unknown = undefined;
    if (init?.body) {
      try { body = JSON.parse(init.body as string); } catch { body = init.body; }
    }
    calls.push({ path: url, method, body });

    const idx = queue.findIndex(q => {
      if (q.matcher.method && q.matcher.method.toUpperCase() !== method.toUpperCase()) return false;
      if (q.matcher.path && !url.includes(q.matcher.path)) return false;
      return true;
    });
    if (idx < 0) {
      throw new Error(`fetchStub: unexpected ${method} ${url} — no matching respondWith() was registered`);
    }
    const queued = queue.splice(idx, 1)[0]!;
    const spec = queued.spec;

    if (spec.type === 'network-error') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(spec.body), {
      status: spec.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  return {
    respondWith(matcher, spec) { queue.push({ matcher, spec }); },
    networkError(matcher = {}) { queue.push({ matcher, spec: { type: 'network-error' } }); },
    calls,
    restore() { globalThis.fetch = original; },
  };
}
