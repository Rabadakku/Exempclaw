/** Recording fake fetch for connector tests. */

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

export interface Route {
  /** Substring (or RegExp) matched against the full URL. */
  match: string | RegExp;
  /** Response body (object → JSON). Functions receive the recorded request. */
  reply: unknown | ((req: RecordedRequest) => unknown);
  status?: number;
  /** Use this route at most this many times (default unlimited). */
  times?: number;
  headers?: Record<string, string>;
}

export interface FakeFetch {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  requests: RecordedRequest[];
  /** Requests whose URL contains the given substring. */
  to(match: string): RecordedRequest[];
}

export function fakeFetch(routes: Route[]): FakeFetch {
  const requests: RecordedRequest[] = [];
  const remaining = routes.map((r) => ({ ...r, used: 0 }));

  const impl = async (input: string, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init?.headers ?? {})) headers[k.toLowerCase()] = String(v);
    const request: RecordedRequest = {
      url: input,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    requests.push(request);

    const route = remaining.find(
      (r) =>
        (typeof r.match === "string" ? input.includes(r.match) : r.match.test(input)) &&
        (r.times === undefined || r.used < r.times),
    );
    if (!route) {
      return new Response(JSON.stringify({ error: `no fake route for ${input}` }), { status: 599 });
    }
    route.used++;
    const body = typeof route.reply === "function" ? (route.reply as (r: RecordedRequest) => unknown)(request) : route.reply;
    return new Response(JSON.stringify(body), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json", ...route.headers },
    });
  };

  return {
    fetch: impl,
    requests,
    to: (match) => requests.filter((r) => r.url.includes(match)),
  };
}
