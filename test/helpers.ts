/**
 * A recording fetch stub. Nothing in the suite touches the network: every
 * client is built with `fetch: mock.fetch`.
 */

import { Precleared, type FetchLike, type FetchRequestInit, type FetchResponseLike, type PreclearedOptions } from "../src/index";

import { HEALTH_PAYLOAD, OK_PAYLOAD, RECEIPT_PAYLOAD } from "./fixtures";

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  signal: AbortSignal | undefined;
}

export type Handler = (request: RecordedRequest) => FetchResponseLike | Promise<FetchResponseLike>;

class StubHeaders {
  private readonly map = new Map<string, string>();

  constructor(headers: Record<string, string> = {}) {
    for (const [name, value] of Object.entries(headers)) this.map.set(name.toLowerCase(), value);
  }

  get(name: string): string | null {
    return this.map.get(name.toLowerCase()) ?? null;
  }
}

export function rawResponse(status: number, text: string, headers: Record<string, string> = {}): FetchResponseLike {
  return {
    status,
    headers: new StubHeaders(headers),
    text: async () => text,
  };
}

export function jsonResponse(status: number, payload: unknown, headers: Record<string, string> = {}): Handler {
  return () => rawResponse(status, JSON.stringify(payload), { "content-type": "application/json", ...headers });
}

/** Route by path so one stub can serve all three endpoints. */
export function routed(routes: { check?: Handler; receipt?: Handler; health?: Handler } = {}): Handler {
  return (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/api/v1/check" && request.method === "POST") {
      return (routes.check ?? jsonResponse(200, OK_PAYLOAD))(request);
    }
    if (url.pathname === "/api/v1/receipt" && request.method === "GET") {
      return (routes.receipt ?? jsonResponse(200, RECEIPT_PAYLOAD))(request);
    }
    if (url.pathname === "/api/v1/health" && request.method === "GET") {
      return (routes.health ?? jsonResponse(200, HEALTH_PAYLOAD))(request);
    }
    return rawResponse(404, JSON.stringify({ error: "not_found", message: `no route ${request.method} ${url.pathname}` }));
  };
}

/** Answer each call with the next handler in the list; the last one repeats. */
export function sequence(...handlers: Handler[]): Handler {
  let index = 0;
  return (request) => {
    const handler = handlers[Math.min(index, handlers.length - 1)]!;
    index += 1;
    return handler(request);
  };
}

export class MockFetch {
  readonly requests: RecordedRequest[] = [];
  readonly fetch: FetchLike;

  constructor(handler: Handler = routed()) {
    this.fetch = async (url: string, init: FetchRequestInit) => {
      const request: RecordedRequest = {
        url,
        method: init.method,
        headers: { ...init.headers },
        body: init.body,
        signal: init.signal,
      };
      this.requests.push(request);
      return handler(request);
    };
  }

  get last(): RecordedRequest {
    const request = this.requests[this.requests.length - 1];
    if (!request) throw new Error("no request was made");
    return request;
  }

  lastJson(): Record<string, unknown> {
    return JSON.parse(this.last.body ?? "null") as Record<string, unknown>;
  }

  header(name: string): string | undefined {
    const wanted = name.toLowerCase();
    for (const [key, value] of Object.entries(this.last.headers)) {
      if (key.toLowerCase() === wanted) return value;
    }
    return undefined;
  }
}

/** A client wired to a fresh recording stub. Retries have no delay unless asked. */
export function makeClient(
  handler?: Handler,
  options: PreclearedOptions = {},
): { client: Precleared; mock: MockFetch } {
  const mock = new MockFetch(handler);
  const client = new Precleared({ fetch: mock.fetch, retryDelayMs: 0, ...options });
  return { client, mock };
}

/** A fetch that never answers until its signal is aborted. */
export const hanging: Handler = (request) =>
  new Promise((_resolve, reject) => {
    request.signal?.addEventListener("abort", () => {
      const error = new Error("This operation was aborted");
      error.name = "AbortError";
      reject(error);
    });
  });

/** A fetch that fails the way undici does when the host is unreachable. */
export const unreachable: Handler = () => {
  const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" });
  throw new TypeError("fetch failed", { cause });
};
