/**
 * The Precleared client.
 *
 *     const client = new Precleared({ apiKey: process.env.PRECLEARED_API_KEY });
 *     const result = await client.check({ recipient_email: "jane@acme.co.uk", pitch: "Bookkeeping software" });
 *
 * Every check is validated with zod before anything is sent. The API key goes
 * in `Authorization: Bearer ...` and is never logged or included in an error.
 * Each request has a timeout (20 seconds by default) and is retried once on a
 * network error or a 5xx response, never on a 4xx.
 */

import {
  AuthError,
  NetworkError,
  PaymentRequiredError,
  PreclearedError,
  RateLimitError,
  ReceiptNotFoundError,
  ServerError,
  ValidationError,
  type ValidationIssue,
} from "./errors";
import {
  isRecord,
  normaliseCheckResult,
  normaliseHealth,
  normaliseReceiptId,
  receiptFromPayload,
} from "./result";
import { checkInputSchema } from "./schemas";
import { DEFAULT_BASE_URL, type CheckInput, type CheckResult, type Health, type Receipt } from "./types";
import { VERSION } from "./version";

export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_RETRIES = 1;
export const DEFAULT_RETRY_DELAY_MS = 300;
export const DEFAULT_USER_AGENT = `precleared-js/${VERSION}`;
export const ENV_API_KEY = "PRECLEARED_API_KEY";

// ---------------------------------------------------------------------------
// fetch, kept structural so any fetch (Node, browser, undici, a test stub) fits
// ---------------------------------------------------------------------------

export interface FetchRequestInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface FetchResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type FetchLike = (url: string, init: FetchRequestInit) => Promise<FetchResponseLike>;

export interface PreclearedOptions {
  /**
   * `pc_live_...` key. Optional: without one the keyless allowance applies
   * (10 checks a day per network). When left undefined, the
   * `PRECLEARED_API_KEY` environment variable is used if set. Pass `null` or
   * an empty string to force keyless use.
   */
  apiKey?: string | null;
  /** API origin. Only change this for testing. */
  baseUrl?: string;
  /** Milliseconds to wait for each attempt. Default 20000. A check can take up to 25 seconds when a register is slow. */
  timeoutMs?: number;
  /** A fetch implementation. Defaults to the global `fetch` (Node 18 or later). */
  fetch?: FetchLike;
  /** Retries after a network error or a 5xx response. Default 1. Never retries a 4xx. */
  retries?: number;
  /** Milliseconds to wait before a retry. Default 300. */
  retryDelayMs?: number;
  /** Sent on every request. Precleared's hosting refuses requests without one. */
  userAgent?: string;
}

export interface RequestOptions {
  /** Cancels the request. The abort reason is thrown as is and is never retried. */
  signal?: AbortSignal;
  /** Overrides the client's timeout for this request. */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Request building and validation
// ---------------------------------------------------------------------------

const KNOWN_FIELDS = new Set([
  "recipient_email",
  "recipient_domain",
  "pitch",
  "address_source",
  "sender_country",
  "existing_customer",
  "pitch_relevant",
  "company_number",
  "recipient_country",
  "default_recipient_country",
  "suppressed",
]);

const UPPER_FIELDS = new Set(["sender_country", "recipient_country", "default_recipient_country"]);

function normaliseField(key: string, value: unknown): unknown {
  if (key === "company_number" && typeof value === "number") return String(value);
  if (typeof value !== "string") return value;
  let text = value.trim();
  if (text === "") return undefined;
  if (key === "address_source") text = text.toLowerCase();
  if (UPPER_FIELDS.has(key)) text = text.toUpperCase();
  return text;
}

interface ZodLikeError {
  issues: Array<{ path: ReadonlyArray<PropertyKey>; message: string }>;
}

function validationErrorFromZod(error: ZodLikeError): ValidationError {
  const issues: ValidationIssue[] = error.issues.map((issue) => ({
    path: issue.path.map((part) => (typeof part === "symbol" ? String(part) : part)),
    message: issue.message,
  }));
  const message = issues
    .map((issue) => {
      const field = issue.path.map(String).join(".");
      return field && !issue.message.startsWith(field) ? `${field}: ${issue.message}` : issue.message;
    })
    .join("; ");
  return new ValidationError(message || "invalid arguments", { code: "invalid_arguments", issues });
}

/**
 * Validate the check fields and build the JSON body. Throws `ValidationError`
 * before anything is sent when a field is malformed. `address_source` is
 * always sent (`unknown` unless you say otherwise), so the caller's choice is
 * explicit in every receipt.
 */
export function buildCheckBody(input: CheckInput): Record<string, unknown> {
  if (!isRecord(input)) {
    throw new ValidationError("check() takes an object with recipient_email or recipient_domain", {
      code: "invalid_arguments",
    });
  }
  const known: Record<string, unknown> = {};
  const extras: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(input)) {
    if (raw === undefined || raw === null) continue;
    if (!KNOWN_FIELDS.has(key)) {
      extras[key] = raw;
      continue;
    }
    const value = normaliseField(key, raw);
    if (value !== undefined) known[key] = value;
  }

  const parsed = checkInputSchema.safeParse(known);
  if (!parsed.success) throw validationErrorFromZod(parsed.error);
  const fields = parsed.data;

  const body: Record<string, unknown> = {};
  if (fields.recipient_email) body.recipient_email = fields.recipient_email;
  if (fields.recipient_domain) body.recipient_domain = fields.recipient_domain;
  body.sender_country = fields.sender_country ?? "GB";
  body.address_source = fields.address_source ?? "unknown";
  body.existing_customer = fields.existing_customer ?? false;
  if (fields.pitch) body.pitch = fields.pitch;
  if (fields.pitch_relevant !== undefined) body.pitch_relevant = fields.pitch_relevant;
  if (fields.company_number) body.company_number = fields.company_number;
  if (fields.recipient_country) body.recipient_country = fields.recipient_country;
  if (fields.default_recipient_country) body.default_recipient_country = fields.default_recipient_country;
  if (fields.suppressed !== undefined) body.suppressed = fields.suppressed;
  for (const [key, value] of Object.entries(extras)) {
    if (!(key in body)) body[key] = value;
  }
  return body;
}

// ---------------------------------------------------------------------------
// Response handling
// ---------------------------------------------------------------------------

/**
 * Turn `retry_after` (body) or `Retry-After` (header) into seconds. The header
 * may be a number of seconds or an HTTP-date. Returns undefined when neither
 * is usable.
 */
export function parseRetryAfter(bodyValue: unknown, headerValue: string | null | undefined): number | undefined {
  if (bodyValue !== null && bodyValue !== undefined && typeof bodyValue !== "boolean") {
    const number = typeof bodyValue === "number" ? bodyValue : Number(String(bodyValue).trim());
    if (Number.isFinite(number)) return Math.max(0, number);
  }
  if (!headerValue) return undefined;
  const text = headerValue.trim();
  if (text === "") return undefined;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Math.max(0, Number(text));
  const when = Date.parse(text);
  if (Number.isNaN(when)) return undefined;
  return Math.max(0, (when - Date.now()) / 1000);
}

function safeJsonObject(text: string): Record<string, unknown> {
  try {
    const data: unknown = JSON.parse(text);
    return isRecord(data) ? data : {};
  } catch {
    return {};
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Map an error response to the matching error (does not throw). */
export function errorFromResponse(
  status: number,
  text: string,
  headers: { get(name: string): string | null },
  options: { receipt?: boolean } = {},
): PreclearedError {
  const body = safeJsonObject(text);
  const code = str(body.error);
  const message = str(body.message);
  const common = { status, body };

  if (status === 400) {
    return new ValidationError(message ?? "Precleared rejected the request body.", {
      ...common,
      code: code ?? "invalid_request",
    });
  }
  if (status === 401) {
    return new AuthError(message ?? "The API key is invalid or has been revoked.", {
      ...common,
      code: code ?? "invalid_key",
    });
  }
  if (status === 402) {
    return new PaymentRequiredError(message ?? "Free daily checks are used and this key has no pack credits.", {
      ...common,
      code: code ?? "payment_required",
      buyUrl: str(body.buy_url),
    });
  }
  if (status === 404 && options.receipt) {
    return new ReceiptNotFoundError(message ?? "No receipt has that id.", { ...common, code: code ?? "not_found" });
  }
  if (status === 429) {
    const retryAfter = parseRetryAfter(body.retry_after, headers.get("Retry-After"));
    const daily = code === "daily_limit" || (code === undefined && "get_key_url" in body);
    if (daily) {
      return new RateLimitError(message ?? "The free daily allowance is used up.", {
        ...common,
        code: "daily_limit",
        kind: "daily_limit",
        retryAfter,
        getKeyUrl: str(body.get_key_url),
      });
    }
    return new RateLimitError(message ?? "Too many checks: the limit is 60 a minute per key.", {
      ...common,
      code: code ?? "rate_limited",
      kind: "rate_limited",
      retryAfter,
    });
  }
  if (status >= 500) {
    return new ServerError(message ?? `Precleared returned HTTP ${status}.`, { ...common, code: code ?? "server_error" });
  }
  return new PreclearedError(message ?? `Unexpected HTTP ${status} from Precleared.`, { ...common, code });
}

function parseJsonObject(text: string, status: number): Record<string, unknown> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new PreclearedError("Precleared returned a response that is not JSON.", {
      status,
      code: "invalid_response",
      cause: error,
    });
  }
  if (!isRecord(data)) {
    throw new PreclearedError("Precleared returned JSON that is not an object.", { status, code: "invalid_response" });
  }
  return data;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    const causeCode = isRecord(cause) && typeof cause.code === "string" ? ` [${cause.code}]` : "";
    return `${error.name}: ${error.message}${causeCode}`;
  }
  return String(error);
}

function abortReason(signal: AbortSignal): unknown {
  const reason = (signal as { reason?: unknown }).reason;
  if (reason !== undefined) return reason;
  const error = new Error("The request was aborted.");
  error.name = "AbortError";
  return error;
}

function resolveApiKey(apiKey: string | null | undefined): string | null {
  let value: unknown = apiKey;
  if (value === undefined) {
    const env = typeof process !== "undefined" ? process.env : undefined;
    value = env ? env[ENV_API_KEY] : undefined;
  }
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new TypeError("apiKey must be a string, null or undefined");
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function positiveNumber(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive number`);
  }
  return value;
}

function countOption(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0) throw new TypeError(`${name} must be a whole number of 0 or more`);
  return value;
}

type HeadersLike = { get(name: string): string | null };

interface Attempt {
  status: number;
  headers: HeadersLike;
  text: string;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class Precleared {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly retries: number;
  readonly retryDelayMs: number;
  readonly userAgent: string;
  readonly #apiKey: string | null;
  readonly #fetch: FetchLike;

  constructor(options: PreclearedOptions = {}) {
    const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    if (typeof baseUrl !== "string" || !/^https?:\/\//i.test(baseUrl)) {
      throw new TypeError("baseUrl must start with http:// or https://");
    }
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.#apiKey = resolveApiKey(options.apiKey);
    this.timeoutMs = positiveNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs");
    this.retries = countOption(options.retries, DEFAULT_RETRIES, "retries");
    this.retryDelayMs = options.retryDelayMs === 0 ? 0 : positiveNumber(options.retryDelayMs, DEFAULT_RETRY_DELAY_MS, "retryDelayMs");
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;

    const globalFetch = (globalThis as { fetch?: unknown }).fetch;
    const fetchImpl = options.fetch ?? (typeof globalFetch === "function" ? (globalFetch as FetchLike).bind(globalThis) : undefined);
    if (typeof fetchImpl !== "function") {
      throw new TypeError("No fetch implementation found. Use Node 18 or later, or pass one with the fetch option.");
    }
    this.#fetch = fetchImpl;
  }

  /** Whether requests carry a key. The key itself is never exposed. */
  get hasApiKey(): boolean {
    return this.#apiKey !== null;
  }

  /**
   * Check whether a cold email may lawfully be sent to one address.
   *
   * Throws `ValidationError` for a malformed field before anything is sent,
   * and a `PreclearedError` subclass per API error (see `errors.ts`).
   */
  async check(input: CheckInput, options: RequestOptions = {}): Promise<CheckResult> {
    const body = buildCheckBody(input);
    const data = await this.#request("POST", "/api/v1/check", { body, ...options });
    return normaliseCheckResult(data);
  }

  /**
   * Fetch a signed receipt by id (`cc_rcpt_...`) or receipt URL. Throws
   * `ReceiptNotFoundError` when no receipt has that id.
   */
  async getReceipt(receiptId: string, options: RequestOptions = {}): Promise<Receipt> {
    const id = normaliseReceiptId(receiptId);
    const data = await this.#request("GET", "/api/v1/receipt", { query: { id }, receipt: true, ...options });
    return receiptFromPayload(data);
  }

  /** Alias of `getReceipt()`, named as in the Python SDK and the MCP server. */
  verifyReceipt(receiptId: string, options: RequestOptions = {}): Promise<Receipt> {
    return this.getReceipt(receiptId, options);
  }

  /** The latest five-minute health pulse: `GET /api/v1/health`. */
  async health(options: RequestOptions = {}): Promise<Health> {
    const data = await this.#request("GET", "/api/v1/health", options);
    return normaliseHealth(data);
  }

  /** Shown by `console.log(client)` and `util.inspect`. Never includes the key. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `Precleared { baseUrl: '${this.baseUrl}', apiKey: ${this.#apiKey ? "<set>" : "none"} }`;
  }

  toJSON(): { baseUrl: string; hasApiKey: boolean } {
    return { baseUrl: this.baseUrl, hasApiKey: this.hasApiKey };
  }

  #headers(hasBody: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": this.userAgent,
    };
    if (hasBody) headers["Content-Type"] = "application/json";
    if (this.#apiKey) headers.Authorization = `Bearer ${this.#apiKey}`;
    return headers;
  }

  async #request(
    method: "GET" | "POST",
    path: string,
    options: RequestOptions & { body?: unknown; query?: Record<string, string>; receipt?: boolean },
  ): Promise<Record<string, unknown>> {
    const query = options.query ? `?${new URLSearchParams(options.query).toString()}` : "";
    const url = `${this.baseUrl}${path}${query}`;
    const init: FetchRequestInit = { method, headers: this.#headers(options.body !== undefined) };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);
    const timeoutMs = positiveNumber(options.timeoutMs, this.timeoutMs, "timeoutMs");

    let attempt = 0;
    for (;;) {
      let outcome: Attempt;
      try {
        outcome = await this.#attempt(url, init, timeoutMs, options.signal);
      } catch (error) {
        const retryable = error instanceof NetworkError && attempt < this.retries && !options.signal?.aborted;
        if (!retryable) throw error;
        attempt += 1;
        await this.#pause();
        continue;
      }
      if (outcome.status >= 500 && attempt < this.retries && !options.signal?.aborted) {
        attempt += 1;
        await this.#pause();
        continue;
      }
      if (outcome.status >= 400) {
        throw errorFromResponse(outcome.status, outcome.text, outcome.headers, { receipt: options.receipt });
      }
      return parseJsonObject(outcome.text, outcome.status);
    }
  }

  async #attempt(url: string, init: FetchRequestInit, timeoutMs: number, signal: AbortSignal | undefined): Promise<Attempt> {
    if (signal?.aborted) throw abortReason(signal);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await this.#fetch(url, { ...init, signal: controller.signal });
      const text = await response.text();
      return { status: response.status, headers: response.headers, text };
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal);
      if (timedOut) {
        throw new NetworkError(`Precleared did not respond within ${timeoutMs} ms.`, { code: "timeout", cause: error });
      }
      throw new NetworkError(`Could not reach Precleared (${describeError(error)})`, {
        code: "network_error",
        cause: error,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  #pause(): Promise<void> {
    if (this.retryDelayMs <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
  }
}
