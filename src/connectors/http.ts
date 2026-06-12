import { ConnectorError } from "../core/errors.js";
import { sleep } from "./connector.js";

/**
 * Minimal JSON-over-HTTPS client shared by the fetch-based connectors
 * (Slack, GitHub, Notion). Handles timeouts, 429/5xx retries with
 * Retry-After, and maps failures to ConnectorError. The fetch implementation
 * is injectable so connector logic is unit-testable without a network.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpJsonOptions {
  connector: string;
  baseUrl: string;
  headers?: Record<string, string>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** Max retries on 429/5xx. Default 2. */
  maxRetries?: number;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export class HttpJson {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(private readonly opts: HttpJsonOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxRetries = opts.maxRetries ?? 2;
  }

  get<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request("GET", path, options);
  }

  post<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request("POST", path, options);
  }

  patch<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request("PATCH", path, options);
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = this.buildUrl(path, options.query);

    for (let attempt = 0; ; attempt++) {
      const signal = options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(this.timeoutMs)])
        : AbortSignal.timeout(this.timeoutMs);

      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers: {
            accept: "application/json",
            ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
            ...this.opts.headers,
            ...options.headers,
          },
          ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
          signal,
        });
      } catch (err) {
        if (options.signal?.aborted) throw err;
        throw new ConnectorError(this.opts.connector, `request to ${path} failed: ${(err as Error).message}`, {
          retryable: true,
          cause: err,
        });
      }

      if (response.ok) {
        const text = await response.text();
        return (text ? JSON.parse(text) : undefined) as T;
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < this.maxRetries) {
        const retryAfter = Number(response.headers.get("retry-after"));
        const delayMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
        await sleep(delayMs, options.signal);
        if (options.signal?.aborted) {
          throw new ConnectorError(this.opts.connector, `request to ${path} aborted`, { retryable: false });
        }
        continue;
      }

      const detail = (await response.text().catch(() => "")).slice(0, 300);
      throw new ConnectorError(
        this.opts.connector,
        `${method} ${path} → HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
        { retryable },
      );
    }
  }

  private buildUrl(path: string, query?: RequestOptions["query"]): string {
    const url = new URL(path.startsWith("http") ? path : `${this.opts.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }
}
