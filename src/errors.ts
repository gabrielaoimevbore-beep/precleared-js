/**
 * Errors thrown by the Precleared client.
 *
 * Every error is a subclass of `PreclearedError`, with `status` (HTTP status,
 * or undefined when no response arrived), `code` (the API's short error code,
 * such as `daily_limit`) and `body` (the parsed JSON error body, if any).
 *
 * `ValidationError` covers both a bad argument caught before anything is sent
 * (`status` undefined, `code` `invalid_arguments`, `issues` filled in) and an
 * HTTP 400 from the API (`status` 400, the message names the field).
 *
 * None of these errors ever carries the API key or the request headers.
 */

const BRAND = Symbol.for("precleared.error");

export interface PreclearedErrorOptions {
  status?: number;
  code?: string;
  body?: Record<string, unknown>;
  cause?: unknown;
}

export interface ValidationIssue {
  path: Array<string | number>;
  message: string;
}

export class PreclearedError extends Error {
  /** HTTP status of the response, or undefined for errors before a response. */
  readonly status: number | undefined;
  /** The API's short error code (for example `daily_limit`), if any. */
  readonly code: string | undefined;
  /** The parsed JSON error body, if the API sent one. */
  readonly body: Record<string, unknown>;

  constructor(message: string, options: PreclearedErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "PreclearedError";
    this.status = options.status;
    this.code = options.code;
    this.body = options.body ?? {};
    Object.defineProperty(this, BRAND, { value: true, enumerable: false });
  }
}

/** A bad argument (before any request) or HTTP 400 (the API rejected the body). */
export class ValidationError extends PreclearedError {
  /** Field-level problems, filled in for client-side validation. */
  readonly issues: ValidationIssue[];

  constructor(message: string, options: PreclearedErrorOptions & { issues?: ValidationIssue[] } = {}) {
    super(message, options);
    this.name = "ValidationError";
    this.issues = options.issues ?? [];
  }
}

/** HTTP 401: the key is wrong (`invalid_key`) or has been revoked (`revoked_key`). */
export class AuthError extends PreclearedError {
  constructor(message: string, options: PreclearedErrorOptions = {}) {
    super(message, options);
    this.name = "AuthError";
  }
}

/** HTTP 402: the free daily checks are used and the key has no pack credits. */
export class PaymentRequiredError extends PreclearedError {
  /** Checkout link for a pack on this key (GBP 39 for 2,000 checks). */
  readonly buyUrl: string | undefined;

  constructor(message: string, options: PreclearedErrorOptions & { buyUrl?: string } = {}) {
    super(message, options);
    this.name = "PaymentRequiredError";
    this.buyUrl = options.buyUrl;
  }
}

export type RateLimitKind = "daily_limit" | "rate_limited";

/**
 * HTTP 429. `kind` is `daily_limit` when the free daily allowance is used up
 * (10 keyless checks a day per network, 25 with a free key) and `rate_limited`
 * when a key has made more than 60 checks in a minute.
 */
export class RateLimitError extends PreclearedError {
  readonly kind: RateLimitKind;
  /** Seconds to wait before trying again, when the API said. */
  readonly retryAfter: number | undefined;
  /** Where to get a free key, sent with `daily_limit`. */
  readonly getKeyUrl: string | undefined;

  constructor(
    message: string,
    options: PreclearedErrorOptions & { kind: RateLimitKind; retryAfter?: number; getKeyUrl?: string },
  ) {
    super(message, options);
    this.name = "RateLimitError";
    this.kind = options.kind;
    this.retryAfter = options.retryAfter;
    this.getKeyUrl = options.getKeyUrl;
  }
}

/** HTTP 404 from the receipt endpoint: no receipt has that id. */
export class ReceiptNotFoundError extends PreclearedError {
  constructor(message: string, options: PreclearedErrorOptions = {}) {
    super(message, options);
    this.name = "ReceiptNotFoundError";
  }
}

/** HTTP 5xx: Precleared itself failed. The client retries once before throwing this. */
export class ServerError extends PreclearedError {
  constructor(message: string, options: PreclearedErrorOptions = {}) {
    super(message, options);
    this.name = "ServerError";
  }
}

/**
 * The request never completed: DNS, connection or timeout failure. `code` is
 * `timeout` or `network_error`; the underlying error is `cause`.
 */
export class NetworkError extends PreclearedError {
  constructor(message: string, options: PreclearedErrorOptions = {}) {
    super(message, options);
    this.name = "NetworkError";
  }
}

/**
 * True for any error this package throws, even across duplicate copies of the
 * module (where `instanceof` would fail).
 */
export function isPreclearedError(error: unknown): error is PreclearedError {
  if (error instanceof PreclearedError) return true;
  return typeof error === "object" && error !== null && (error as Record<symbol, unknown>)[BRAND] === true;
}
