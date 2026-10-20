import { describe, expect, it } from "vitest";

import {
  PaymentRequiredError,
  RateLimitError,
  ValidationError,
  coerceBool,
  createToolHandlers,
  errorPayload,
  formatError,
} from "../src/index";

import { CONSENT_PAYLOAD, CONSENT_RECEIPT, KEY } from "./fixtures";
import { jsonResponse, makeClient, routed, unreachable } from "./helpers";

describe("createToolHandlers: contact_check", () => {
  it("returns compact text", async () => {
    const { client, mock } = makeClient();
    const text = await createToolHandlers(client).contact_check({ recipient_email: "jane@acme.co.uk", pitch: "Bookkeeping", address_source: "bought" });
    expect(typeof text).toBe("string");
    expect(text.split("\n")[0]).toBe("verdict: ok_to_email (confidence: high)");
    expect(text).toContain("rule: us_canspam_ok");
    expect(text).toContain("footer_text: Truthful From and subject line");
    expect(text).toContain("next_step: Send.");
    expect(text).toContain("receipt: cc_rcpt_363BBFMQ3YNSKA6A https://precleared.dev/r/cc_rcpt_363BBFMQ3YNSKA6A");
    expect(mock.lastJson().address_source).toBe("bought");
  });

  it("returns an object with format json", async () => {
    const { client } = makeClient();
    const out = await createToolHandlers(client, { format: "json" }).contact_check({ recipient_email: "jane@acme.co.uk" });
    expect(typeof out).toBe("object");
    expect(out).toMatchObject({
      verdict: "ok_to_email",
      rule: "us_canspam_ok",
      receipt_url: "https://precleared.dev/r/cc_rcpt_363BBFMQ3YNSKA6A",
    });
  });

  it("normalises blank strings and string booleans from models", async () => {
    const { client, mock } = makeClient();
    await createToolHandlers(client).contact_check({
      recipient_email: "jane@acme.co.uk",
      recipient_domain: "",
      pitch: "",
      address_source: "",
      existing_customer: "false",
      pitch_relevant: "true",
      sender_country: "",
      recipient_country: " gb ",
      company_number: "",
      suppressed: "no",
    });
    expect(mock.lastJson()).toEqual({
      recipient_email: "jane@acme.co.uk",
      sender_country: "GB",
      address_source: "unknown",
      existing_customer: false,
      pitch_relevant: true,
      recipient_country: "GB",
      suppressed: false,
    });
  });

  it("returns error text for bad arguments instead of throwing", async () => {
    const { client, mock } = makeClient();
    const handlers = createToolHandlers(client);

    const text = await handlers.contact_check({ recipient_email: "jane@acme.co.uk", address_source: "guessed" });
    expect(text.startsWith("error: invalid_arguments")).toBe(true);
    expect(text).toContain("address_source must be one of");
    expect(text.endsWith("Do not send until a check succeeds.")).toBe(true);
    expect(mock.requests).toEqual([]);

    expect(await handlers.contact_check({})).toContain("recipient_email or recipient_domain is required");
    expect(await handlers.contact_check({ recipient_email: "jane@acme.co.uk", suppressed: "maybe" })).toContain("suppressed must be true or false");
    expect(await handlers.contact_check(undefined as never)).toContain("recipient_email or recipient_domain is required");
  });

  it("turns API errors into text with hints", async () => {
    const daily = makeClient(
      routed({ check: jsonResponse(429, { error: "daily_limit", message: "Keyless allowance used.", get_key_url: "https://precleared.dev/get-key" }) }),
    );
    const text = await createToolHandlers(daily.client).contact_check({ recipient_email: "jane@acme.co.uk" });
    expect(text.split("\n")).toEqual([
      "error: daily_limit",
      "message: Keyless allowance used.",
      "get_key_url: https://precleared.dev/get-key",
      "Do not send until a check succeeds.",
    ]);

    const limited = makeClient(routed({ check: jsonResponse(429, { error: "rate_limited", retry_after: 4 }) }));
    const out = await createToolHandlers(limited.client, { format: "json" }).contact_check({ recipient_email: "jane@acme.co.uk" });
    expect(out).toEqual({
      error: "rate_limited",
      message: "Too many checks: the limit is 60 a minute per key.",
      status_code: 429,
      retry_after: 4,
    });

    const pay = makeClient(routed({ check: jsonResponse(402, { error: "payment_required", message: "Buy a pack.", buy_url: "https://precleared.dev/buy?k=1" }) }));
    const payOut = await createToolHandlers(pay.client, { format: "json" }).contact_check({ recipient_email: "jane@acme.co.uk" });
    expect(payOut).toMatchObject({ error: "payment_required", buy_url: "https://precleared.dev/buy?k=1", status_code: 402 });

    const down = makeClient(routed({ check: unreachable }));
    const downText = await createToolHandlers(down.client).contact_check({ recipient_email: "jane@acme.co.uk" });
    expect(downText.split("\n")[0]).toBe("error: network_error");
  });

  it("consent_needed text has no footer line", async () => {
    const { client } = makeClient(routed({ check: jsonResponse(200, CONSENT_PAYLOAD) }));
    const text = await createToolHandlers(client).contact_check({ recipient_email: "bob@soletrader.co.uk" });
    expect(text.startsWith("verdict: consent_needed")).toBe(true);
    expect(text).not.toContain("footer_text");
    expect(text).toContain("next_step: Do not cold email.");
  });

  it("sends the client's key and respects its base URL", async () => {
    const { client, mock } = makeClient(undefined, { apiKey: KEY, baseUrl: "https://staging.example.test" });
    const text = await createToolHandlers(client).contact_check({ recipient_email: "jane@acme.co.uk" });
    expect(mock.header("authorization")).toBe(`Bearer ${KEY}`);
    expect(text).toContain("https://staging.example.test/r/cc_rcpt_363BBFMQ3YNSKA6A");
    expect(text).not.toContain(KEY);
  });

  it("lets a caller's abort propagate rather than turning it into text", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    const { client } = makeClient();
    await expect(createToolHandlers(client).contact_check({ recipient_email: "jane@acme.co.uk" }, { signal: controller.signal })).rejects.toThrow("stop");
  });
});

describe("createToolHandlers: verify_receipt", () => {
  it("returns text and json", async () => {
    const { client } = makeClient(routed({ receipt: jsonResponse(200, CONSENT_RECEIPT) }));
    const text = await createToolHandlers(client).verify_receipt({ receipt_id: "cc_rcpt_E21TTJV8D9JAYTQZ" });
    const lines = text.split("\n");
    expect(lines[0]).toBe("receipt: cc_rcpt_E21TTJV8D9JAYTQZ");
    expect(lines).toContain("verdict: consent_needed");
    expect(lines).toContain(`signature: ${CONSENT_RECEIPT.signature}`);
    expect(lines[lines.length - 1]).toBe("receipt_url: https://precleared.dev/r/cc_rcpt_E21TTJV8D9JAYTQZ");
    expect(text).not.toContain("public_key");

    const out = await createToolHandlers(client, { format: "json" }).verify_receipt({ receipt_id: "cc_rcpt_E21TTJV8D9JAYTQZ" });
    expect(out).toMatchObject({
      receipt_id: "cc_rcpt_E21TTJV8D9JAYTQZ",
      request_hash: CONSENT_RECEIPT.request_hash,
      receipt_url: "https://precleared.dev/r/cc_rcpt_E21TTJV8D9JAYTQZ",
    });
    expect(out).not.toHaveProperty("public_key");
  });

  it("reports not found and bad ids as text", async () => {
    const missing = makeClient(routed({ receipt: jsonResponse(404, { error: "not_found", message: "No receipt has that id." }) }));
    const text = await createToolHandlers(missing.client).verify_receipt({ receipt_id: "cc_rcpt_NOPE" });
    expect(text.startsWith("error: not_found")).toBe(true);
    expect(text).toContain("No receipt has that id.");

    const { client } = makeClient();
    expect(await createToolHandlers(client).verify_receipt({ receipt_id: "" })).toMatch(/^error: invalid_arguments/);
    expect(await createToolHandlers(client).verify_receipt(undefined as never)).toMatch(/^error: invalid_arguments/);
  });
});

describe("coerceBool, errorPayload, formatError", () => {
  it.each([
    [undefined, undefined],
    [null, undefined],
    [true, true],
    [false, false],
    ["True", true],
    [" no ", false],
    ["1", true],
    [0, false],
    ["", undefined],
    ["on", true],
  ])("coerceBool(%j) is %j", (value, expected) => {
    expect(coerceBool(value, "x")).toBe(expected);
  });

  it("coerceBool rejects garbage", () => {
    expect(() => coerceBool("maybe", "x")).toThrow("x must be true or false");
    expect(() => coerceBool(2, "x")).toThrow("x must be true or false");
  });

  it("errorPayload and formatError", () => {
    expect(errorPayload(new Error("bad"))).toEqual({ error: "invalid_arguments", message: "bad" });
    expect(errorPayload("odd")).toEqual({ error: "invalid_arguments", message: "odd" });
    const payload = errorPayload(new RateLimitError("slow", { kind: "rate_limited", retryAfter: 2.5, status: 429, code: "rate_limited" }));
    expect(payload).toEqual({ error: "rate_limited", message: "slow", status_code: 429, retry_after: 2.5 });
    expect(formatError(payload).split("\n")).toEqual(["error: rate_limited", "message: slow", "retry_after: 2.5", "Do not send until a check succeeds."]);
    expect(errorPayload(new RateLimitError("d", { kind: "daily_limit", getKeyUrl: "u", code: "daily_limit" })).get_key_url).toBe("u");
    expect(errorPayload(new PaymentRequiredError("p", { buyUrl: "b", code: "payment_required" })).buy_url).toBe("b");
    expect(errorPayload(new ValidationError("v"))).toEqual({ error: "ValidationError", message: "v" });
  });
});
