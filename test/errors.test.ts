import { describe, expect, it } from "vitest";

import {
  AuthError,
  NetworkError,
  PaymentRequiredError,
  PreclearedError,
  RateLimitError,
  ServerError,
  ValidationError,
  isPreclearedError,
} from "../src/index";

import { KEY } from "./fixtures";
import { jsonResponse, makeClient, rawResponse, routed, unreachable } from "./helpers";

const INPUT = { recipient_email: "jane@acme.co.uk" };

async function failing(handler: Parameters<typeof routed>[0], apiKey?: string): Promise<unknown> {
  const { client } = makeClient(routed(handler), { apiKey, retries: 0 });
  return client.check(INPUT).catch((error: unknown) => error);
}

describe("error mapping", () => {
  it("400 becomes ValidationError with the API's message", async () => {
    const error = await failing({
      check: jsonResponse(400, { error: "invalid_request", message: "recipient_email is not an email address" }),
    });
    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toBeInstanceOf(PreclearedError);
    const typed = error as ValidationError;
    expect(typed.status).toBe(400);
    expect(typed.code).toBe("invalid_request");
    expect(typed.message).toBe("recipient_email is not an email address");
    expect(typed.body.error).toBe("invalid_request");
    expect(typed.issues).toEqual([]);
  });

  it.each(["invalid_key", "revoked_key"])("401 %s becomes AuthError and never leaks the key", async (code) => {
    const error = await failing({ check: jsonResponse(401, { error: code, message: `${code} message` }) }, KEY);
    expect(error).toBeInstanceOf(AuthError);
    const typed = error as AuthError;
    expect(typed.status).toBe(401);
    expect(typed.code).toBe(code);
    expect(String(typed)).not.toContain(KEY);
    expect(JSON.stringify(typed.body)).not.toContain(KEY);
  });

  it("401 without a body still maps to AuthError", async () => {
    const error = await failing({ check: () => rawResponse(401, "") }, KEY);
    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).code).toBe("invalid_key");
    expect((error as AuthError).message).toBe("The API key is invalid or has been revoked.");
  });

  it("402 becomes PaymentRequiredError with buyUrl", async () => {
    const payload = { error: "payment_required", message: "Free checks used and no credits left.", buy_url: "https://precleared.dev/buy?key=abc" };
    const error = await failing({ check: jsonResponse(402, payload) }, KEY);
    expect(error).toBeInstanceOf(PaymentRequiredError);
    const typed = error as PaymentRequiredError;
    expect(typed.buyUrl).toBe("https://precleared.dev/buy?key=abc");
    expect(typed.code).toBe("payment_required");
    expect(typed.status).toBe(402);
  });

  it("429 daily_limit becomes RateLimitError with kind daily_limit and getKeyUrl", async () => {
    const payload = { error: "daily_limit", message: "Keyless use is over for the day.", get_key_url: "https://precleared.dev/get-key" };
    const error = await failing({ check: jsonResponse(429, payload) });
    expect(error).toBeInstanceOf(RateLimitError);
    const typed = error as RateLimitError;
    expect(typed.kind).toBe("daily_limit");
    expect(typed.code).toBe("daily_limit");
    expect(typed.getKeyUrl).toBe("https://precleared.dev/get-key");
    expect(typed.retryAfter).toBeUndefined();
  });

  it("429 with get_key_url but no code is a daily limit", async () => {
    const error = await failing({ check: jsonResponse(429, { message: "Daily limit reached.", get_key_url: "https://precleared.dev/get-key" }) });
    expect((error as RateLimitError).kind).toBe("daily_limit");
  });

  it("429 rate_limited reads retry_after from the body", async () => {
    const error = await failing({ check: jsonResponse(429, { error: "rate_limited", message: "Slow down.", retry_after: 12 }) });
    expect(error).toBeInstanceOf(RateLimitError);
    const typed = error as RateLimitError;
    expect(typed.kind).toBe("rate_limited");
    expect(typed.code).toBe("rate_limited");
    expect(typed.retryAfter).toBe(12);
    expect(typed.getKeyUrl).toBeUndefined();
  });

  it("429 rate_limited reads Retry-After seconds from the header", async () => {
    const error = await failing({ check: jsonResponse(429, { error: "rate_limited", message: "Slow down." }, { "Retry-After": "7" }) });
    expect((error as RateLimitError).retryAfter).toBe(7);
  });

  it("429 rate_limited reads an HTTP-date Retry-After header", async () => {
    const when = new Date(Date.now() + 90_000).toUTCString();
    const error = await failing({ check: jsonResponse(429, { error: "rate_limited" }, { "Retry-After": when }) });
    const typed = error as RateLimitError;
    expect(typed.retryAfter).toBeGreaterThanOrEqual(80);
    expect(typed.retryAfter).toBeLessThanOrEqual(91);
    expect(typed.message).toContain("60 a minute");
  });

  it("429 with no hints is rate_limited with no retryAfter", async () => {
    const error = await failing({ check: jsonResponse(429, {}) });
    expect((error as RateLimitError).kind).toBe("rate_limited");
    expect((error as RateLimitError).retryAfter).toBeUndefined();
  });

  it.each([500, 502, 503])("%s becomes ServerError", async (status) => {
    const error = await failing({ check: jsonResponse(status, { error: "server_error", message: "Something broke." }) });
    expect(error).toBeInstanceOf(ServerError);
    expect((error as ServerError).status).toBe(status);
    expect((error as ServerError).code).toBe("server_error");
    expect((error as ServerError).message).toBe("Something broke.");
  });

  it("a non-JSON error body still maps", async () => {
    const error = await failing({ check: () => rawResponse(503, "<html>bad gateway</html>") });
    expect(error).toBeInstanceOf(ServerError);
    expect((error as ServerError).body).toEqual({});
    expect((error as ServerError).message).toContain("503");
  });

  it("an unexpected status is the base PreclearedError", async () => {
    const error = await failing({ check: jsonResponse(418, { error: "teapot", message: "no" }) });
    expect(error).toBeInstanceOf(PreclearedError);
    expect((error as PreclearedError).constructor).toBe(PreclearedError);
    expect((error as PreclearedError).status).toBe(418);
    expect((error as PreclearedError).code).toBe("teapot");
  });

  it("a 200 that is not JSON throws invalid_response", async () => {
    const error = await failing({ check: () => rawResponse(200, "ok") });
    expect(error).toBeInstanceOf(PreclearedError);
    expect((error as PreclearedError).code).toBe("invalid_response");
    expect((error as PreclearedError).message).toContain("not JSON");
  });

  it("a 200 JSON array throws invalid_response", async () => {
    const error = await failing({ check: jsonResponse(200, [1, 2]) });
    expect((error as PreclearedError).code).toBe("invalid_response");
  });

  it("a 200 without a verdict throws", async () => {
    const error = await failing({ check: jsonResponse(200, { facts: {} }) });
    expect((error as PreclearedError).message).toContain("no verdict");
  });

  it("a connection failure becomes NetworkError with the cause attached", async () => {
    const error = await failing({ check: unreachable });
    expect(error).toBeInstanceOf(NetworkError);
    const typed = error as NetworkError;
    expect(typed.code).toBe("network_error");
    expect(typed.status).toBeUndefined();
    expect(typed.message).toContain("TypeError: fetch failed");
    expect(typed.message).toContain("ECONNREFUSED");
    expect((typed.cause as Error).message).toBe("fetch failed");
  });

  it("errors carry a name and are recognisable across module copies", () => {
    const error = new RateLimitError("x", { kind: "rate_limited" });
    expect(error.name).toBe("RateLimitError");
    expect(isPreclearedError(error)).toBe(true);
    expect(isPreclearedError(new Error("plain"))).toBe(false);
    expect(isPreclearedError(null)).toBe(false);
    // A copy from another bundle: same brand, different prototype chain.
    const foreign = Object.assign(new Error("copy"), { [Symbol.for("precleared.error")]: true });
    expect(isPreclearedError(foreign)).toBe(true);
  });
});
