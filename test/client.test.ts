import { inspect } from "node:util";

import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_USER_AGENT,
  Precleared,
  PreclearedError,
  ReceiptNotFoundError,
  ValidationError,
  isOk,
  mustNotSend,
  needsMoreFacts,
  receiptUrl,
  decidingRule,
  notes,
} from "../src/index";

import { CONSENT_PAYLOAD, CONSENT_RECEIPT, HEALTH_PAYLOAD, KEY, OK_PAYLOAD, RECEIPT_PAYLOAD, UNKNOWN_PAYLOAD } from "./fixtures";
import { jsonResponse, makeClient, rawResponse, routed } from "./helpers";

describe("check(): success path", () => {
  it("maps the live ok_to_email example", async () => {
    const { client } = makeClient();
    const result = await client.check({ recipient_email: "sales@precleared.dev", recipient_country: "US", pitch: "Bookkeeping" });

    expect(result.verdict).toBe("ok_to_email");
    expect(result.confidence).toBe("high");
    expect(isOk(result)).toBe(true);
    expect(mustNotSend(result)).toBe(false);
    expect(needsMoreFacts(result)).toBe(false);
    expect(decidingRule(result)).toBe("us_canspam_ok");
    expect(result.rules_applied).toEqual(["us_canspam_ok"]);
    expect(result.footer_text).toBe(OK_PAYLOAD.footer_text);
    expect(result.next_step).toBe(OK_PAYLOAD.next_step);
    expect(result.facts.recipient_country).toBe("US");
    expect(result.facts.mx_ok).toBe(true);
    expect(result.disclaimer).toMatch(/^Decision support with sources, not legal advice\./);
    expect(result.rules_version).toBe("v1-draft");

    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]?.rule_key).toBe("us_canspam_ok");
    expect(result.reasons[0]?.source_title).toBe("FTC CAN-SPAM Act compliance guide for business");
    expect(result.reasons[0]?.source_url).toMatch(/^https:\/\/www\.ftc\.gov\//);

    expect(result.receipt?.id).toBe("cc_rcpt_363BBFMQ3YNSKA6A");
    expect(result.receipt?.signature).toBe(OK_PAYLOAD.receipt.signature);
    expect(result.receipt?.algorithm).toBe("ed25519");
    expect(result.receipt?.key_version).toBe("k1");
    expect(result.receipt?.verify_url).toBe("https://precleared.dev/api/v1/receipt?id=cc_rcpt_363BBFMQ3YNSKA6A");
    expect(receiptUrl(result)).toBe("https://precleared.dev/r/cc_rcpt_363BBFMQ3YNSKA6A");

    expect(result.usage?.free_remaining_today).toBe(24);
    expect(result.usage?.credits_remaining).toBe(0);
    expect(result.usage?.low_balance).toBeNull();
  });

  it("sends the expected body and headers without a key", async () => {
    const { client, mock } = makeClient();
    await client.check({ recipient_email: "jane@acme.co.uk", pitch: "  Bookkeeping software  " });

    const request = mock.last;
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://precleared.dev/api/v1/check");
    expect(mock.header("content-type")).toBe("application/json");
    expect(mock.header("accept")).toBe("application/json");
    expect(mock.header("user-agent")).toBe("precleared-js/0.1.2");
    expect(DEFAULT_USER_AGENT).toBe("precleared-js/0.1.2");
    expect(mock.header("authorization")).toBeUndefined();

    expect(mock.lastJson()).toEqual({
      recipient_email: "jane@acme.co.uk",
      sender_country: "GB",
      address_source: "unknown",
      existing_customer: false,
      pitch: "Bookkeeping software",
    });
  });

  it("always sends address_source, defaulting to unknown", async () => {
    // address_source changes verdicts, so the client never assumes published.
    const { client, mock } = makeClient();
    await client.check({ recipient_email: "jane@acme.co.uk" });
    expect(mock.lastJson().address_source).toBe("unknown");
  });

  it("sends the bearer header only when a key is given", async () => {
    const keyed = makeClient(undefined, { apiKey: KEY });
    await keyed.client.check({ recipient_email: "jane@acme.co.uk" });
    expect(keyed.mock.header("authorization")).toBe(`Bearer ${KEY}`);
    expect(keyed.client.hasApiKey).toBe(true);

    const keyless = makeClient();
    await keyless.client.check({ recipient_email: "jane@acme.co.uk" });
    expect(keyless.mock.header("authorization")).toBeUndefined();
    expect(keyless.client.hasApiKey).toBe(false);
  });

  it("reads the key from PRECLEARED_API_KEY when apiKey is undefined", async () => {
    vi.stubEnv("PRECLEARED_API_KEY", `  ${KEY}  `);
    const { client, mock } = makeClient();
    expect(client.hasApiKey).toBe(true);
    await client.check({ recipient_email: "jane@acme.co.uk" });
    expect(mock.header("authorization")).toBe(`Bearer ${KEY}`);
  });

  it("treats null and blank keys as keyless, even with the variable set", async () => {
    vi.stubEnv("PRECLEARED_API_KEY", KEY);
    expect(makeClient(undefined, { apiKey: null }).client.hasApiKey).toBe(false);
    expect(makeClient(undefined, { apiKey: "   " }).client.hasApiKey).toBe(false);
  });

  it("sends every optional field, normalised", async () => {
    const { client, mock } = makeClient();
    await client.check({
      recipient_domain: "acme.co.uk",
      pitch: "Bookkeeping",
      address_source: "Published " as "published",
      sender_country: "us",
      existing_customer: true,
      pitch_relevant: true,
      company_number: 1234567,
      recipient_country: " gb ",
      default_recipient_country: "ie",
      suppressed: false,
    });
    expect(mock.lastJson()).toEqual({
      recipient_domain: "acme.co.uk",
      sender_country: "US",
      address_source: "published",
      existing_customer: true,
      pitch: "Bookkeeping",
      pitch_relevant: true,
      company_number: "1234567",
      recipient_country: "GB",
      default_recipient_country: "IE",
      suppressed: false,
    });
  });

  it("leaves null and undefined fields out", async () => {
    const { client, mock } = makeClient();
    await client.check({
      recipient_email: "jane@acme.co.uk",
      pitch: null,
      pitch_relevant: undefined,
      company_number: null,
      recipient_country: undefined,
      default_recipient_country: null,
      suppressed: null,
    });
    const body = mock.lastJson();
    for (const key of ["pitch", "pitch_relevant", "company_number", "recipient_country", "default_recipient_country", "suppressed"]) {
      expect(body).not.toHaveProperty(key);
    }
  });

  it("forwards unknown fields as they are", async () => {
    const { client, mock } = makeClient();
    await client.check({ recipient_email: "jane@acme.co.uk", address_source: "given", campaign_id: "spring-26" } as never);
    expect(mock.lastJson().campaign_id).toBe("spring-26");
    expect(mock.lastJson().address_source).toBe("given");
  });

  it("maps consent_needed and blocked as must-not-send", async () => {
    const consent = makeClient(routed({ check: jsonResponse(200, CONSENT_PAYLOAD) }));
    const result = await consent.client.check({ recipient_email: "bob@soletrader.co.uk" });
    expect(result.verdict).toBe("consent_needed");
    expect(isOk(result)).toBe(false);
    expect(mustNotSend(result)).toBe(true);
    expect(result.footer_text).toBeNull();
    expect(decidingRule(result)).toBe("gb_individual_consent");
    expect(notes(result)).toEqual(["Legal form came from the company website."]);

    const blocked = makeClient(routed({ check: jsonResponse(200, { ...CONSENT_PAYLOAD, verdict: "blocked" }) }));
    expect(mustNotSend(await blocked.client.check({ recipient_email: "bob@soletrader.co.uk" }))).toBe(true);
  });

  it("flags unknown as needing more facts, not as blocked", async () => {
    const { client } = makeClient(routed({ check: jsonResponse(200, UNKNOWN_PAYLOAD) }));
    const result = await client.check({ recipient_email: "hello@example.com", recipient_country: "US" });
    expect(result.verdict).toBe("unknown");
    expect(isOk(result)).toBe(false);
    expect(mustNotSend(result)).toBe(false);
    expect(needsMoreFacts(result)).toBe(true);
    expect(decidingRule(result)).toBe("any_no_mx");
    expect(result.facts.mx_ok).toBe(false);
    expect(result.receipt?.id).toBe("cc_rcpt_4M460J4JCZVFQQTZ");
  });

  it("tolerates odd shapes in a response", async () => {
    const payload = {
      verdict: "ok_to_email",
      reasons: ["a bare note", 42, { rule_key: "x", extra: true }],
      rules_applied: "not-a-list",
      receipt: { signature: "no id here" },
      facts: null,
      usage: { free_remaining_today: "9", low_balance: 1 },
      new_field: { kept: true },
    };
    const { client } = makeClient(routed({ check: jsonResponse(200, payload) }));
    const result = await client.check({ recipient_email: "jane@acme.co.uk" });
    expect(result.reasons).toEqual([{ note: "a bare note" }, {}, expect.objectContaining({ rule_key: "x", extra: true })]);
    expect(result.rules_applied).toEqual([]);
    expect(result.receipt).toBeNull();
    expect(result.facts).toEqual({});
    expect(result.usage?.free_remaining_today).toBe(9);
    expect(result.usage?.low_balance).toBe(true);
    expect(result.confidence).toBeNull();
    expect(result.footer_text).toBeNull();
    expect(result.new_field).toEqual({ kept: true });
  });

  it("uses a custom base URL for requests and receipt pages", async () => {
    const { client, mock } = makeClient(undefined, { baseUrl: "https://staging.example.test/" });
    const result = await client.check({ recipient_email: "jane@acme.co.uk" });
    expect(mock.last.url).toBe("https://staging.example.test/api/v1/check");
    expect(receiptUrl(result, client.baseUrl)).toBe("https://staging.example.test/r/cc_rcpt_363BBFMQ3YNSKA6A");
  });
});

describe("check(): validation before any request", () => {
  it.each(["guessed", "public", "published!", 3, true])("rejects address_source %j", async (bad) => {
    const { client, mock } = makeClient();
    await expect(client.check({ recipient_email: "jane@acme.co.uk", address_source: bad as never })).rejects.toThrow(
      "address_source must be one of published, bought, scraped, given, unknown",
    );
    expect(mock.requests).toEqual([]);
  });

  it("forgives case and whitespace in address_source, and treats blank as not given", async () => {
    const { client, mock } = makeClient();
    await client.check({ recipient_email: "jane@acme.co.uk", address_source: " Bought " as "bought" });
    expect(mock.lastJson().address_source).toBe("bought");
    await client.check({ recipient_email: "jane@acme.co.uk", address_source: "" as never });
    expect(mock.lastJson().address_source).toBe("unknown");
  });

  it("requires recipient_email or recipient_domain", async () => {
    const { client, mock } = makeClient();
    await expect(client.check({})).rejects.toThrow("recipient_email or recipient_domain is required");
    await expect(client.check({ recipient_email: "   ", recipient_domain: "" })).rejects.toThrow(ValidationError);
    await expect(client.check(undefined as never)).rejects.toThrow(ValidationError);
    await expect(client.check("jane@acme.co.uk" as never)).rejects.toThrow(ValidationError);
    expect(mock.requests).toEqual([]);
  });

  it.each([
    ["sender_country", "GBR"],
    ["sender_country", "G"],
    ["sender_country", "U K"],
    ["sender_country", 44],
    ["recipient_country", "GBR"],
    ["default_recipient_country", "united kingdom"],
  ])("rejects %s %j", async (field, bad) => {
    const { client, mock } = makeClient();
    const error = await client.check({ recipient_email: "jane@acme.co.uk", [field]: bad }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).message).toContain(`${field} must be a two-letter country code`);
    expect((error as ValidationError).code).toBe("invalid_arguments");
    expect((error as ValidationError).status).toBeUndefined();
    expect((error as ValidationError).issues[0]?.path).toEqual([field]);
    expect(mock.requests).toEqual([]);
  });

  it.each(["existing_customer", "pitch_relevant", "suppressed"])("requires %s to be a boolean", async (field) => {
    const { client } = makeClient();
    await expect(client.check({ recipient_email: "jane@acme.co.uk", [field]: "yes" })).rejects.toThrow(
      `${field} must be true or false`,
    );
  });

  it("is a PreclearedError too, so one catch covers everything", async () => {
    const { client } = makeClient();
    const error = await client.check({}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PreclearedError);
    expect((error as ValidationError).name).toBe("ValidationError");
  });
});

describe("constructor", () => {
  it("rejects a base URL without a scheme", () => {
    expect(() => new Precleared({ baseUrl: "precleared.dev", fetch: async () => rawResponse(200, "{}") })).toThrow(TypeError);
  });

  it("rejects a bad timeout or retry count", () => {
    const fetch = async () => rawResponse(200, "{}");
    expect(() => new Precleared({ fetch, timeoutMs: 0 })).toThrow(TypeError);
    expect(() => new Precleared({ fetch, timeoutMs: Number.NaN })).toThrow(TypeError);
    expect(() => new Precleared({ fetch, retries: -1 })).toThrow(TypeError);
    expect(() => new Precleared({ fetch, retries: 1.5 })).toThrow(TypeError);
  });

  it("explains when no fetch is available", () => {
    const original = globalThis.fetch;
    // @ts-expect-error: simulating a runtime without fetch
    globalThis.fetch = undefined;
    try {
      expect(() => new Precleared()).toThrow(/No fetch implementation found/);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("uses the global fetch by default", () => {
    const spy = vi.fn(async () => rawResponse(200, JSON.stringify(HEALTH_PAYLOAD)));
    vi.stubGlobal("fetch", spy);
    const client = new Precleared();
    return client.health().then(() => expect(spy).toHaveBeenCalledTimes(1));
  });

  it("never shows the key when inspected, logged or serialised", () => {
    const client = new Precleared({ apiKey: KEY, fetch: async () => rawResponse(200, "{}") });
    const shown = inspect(client);
    expect(shown).not.toContain(KEY);
    expect(shown).toContain("apiKey: <set>");
    expect(JSON.stringify(client)).not.toContain(KEY);
    expect(JSON.stringify(client)).toContain('"hasApiKey":true');
    expect(Object.keys(client)).not.toContain("apiKey");
    expect(inspect(new Precleared({ fetch: async () => rawResponse(200, "{}") }))).toContain("apiKey: none");
  });

  it("accepts a custom user agent and timeout", async () => {
    const { client, mock } = makeClient(undefined, { userAgent: "my-agent/2.0", timeoutMs: 5000 });
    await client.check({ recipient_email: "jane@acme.co.uk" });
    expect(mock.header("user-agent")).toBe("my-agent/2.0");
    expect(client.timeoutMs).toBe(5000);
  });
});

describe("getReceipt() and verifyReceipt()", () => {
  it("fetches a receipt by id", async () => {
    const { client, mock } = makeClient();
    const receipt = await client.getReceipt("cc_rcpt_4M460J4JCZVFQQTZ");

    expect(receipt.id).toBe("cc_rcpt_4M460J4JCZVFQQTZ");
    expect(receipt.verdict).toBe("unknown");
    expect(receipt.confidence).toBe("low");
    expect(receipt.rules_applied).toEqual(["any_no_mx"]);
    expect(receipt.recipient_email_masked).toBe("h***@example.com");
    expect(receipt.recipient_domain).toBe("example.com");
    expect(receipt.sender_country).toBe("GB");
    expect(receipt.rules_version).toBe("v1-draft");
    expect(receipt.request_hash).toBe(RECEIPT_PAYLOAD.request_hash);
    expect(receipt.response_hash).toBe(RECEIPT_PAYLOAD.response_hash);
    expect(receipt.signature).toBe(RECEIPT_PAYLOAD.signature);
    expect(receipt.algorithm).toBe("ed25519");
    expect(receipt.key_version).toBe("k1");
    expect(receipt.public_key).toBe("MCowBQYDK2VwAyEAxKYMJSUl95O2MxJPAHNR5HeGD8DFEoNZLP7UZ3cafMM=");
    expect(receipt.verify_url).toBeUndefined();
    expect(receiptUrl(receipt)).toBe("https://precleared.dev/r/cc_rcpt_4M460J4JCZVFQQTZ");

    expect(mock.last.method).toBe("GET");
    expect(mock.last.url).toBe("https://precleared.dev/api/v1/receipt?id=cc_rcpt_4M460J4JCZVFQQTZ");
    expect(mock.header("accept")).toBe("application/json");
    expect(mock.header("content-type")).toBeUndefined();
    expect(mock.last.body).toBeUndefined();
  });

  it("verifyReceipt is the same call", async () => {
    const { client, mock } = makeClient(routed({ receipt: jsonResponse(200, CONSENT_RECEIPT) }));
    const receipt = await client.verifyReceipt("cc_rcpt_E21TTJV8D9JAYTQZ");
    expect(receipt.verdict).toBe("consent_needed");
    expect(mock.last.url).toContain("id=cc_rcpt_E21TTJV8D9JAYTQZ");
  });

  it("accepts a receipt URL or a verify URL", async () => {
    const { client, mock } = makeClient();
    await client.getReceipt("https://precleared.dev/r/cc_rcpt_4M460J4JCZVFQQTZ");
    expect(mock.last.url).toMatch(/id=cc_rcpt_4M460J4JCZVFQQTZ$/);
    await client.getReceipt("https://precleared.dev/api/v1/receipt?id=cc_rcpt_4M460J4JCZVFQQTZ");
    expect(mock.last.url).toMatch(/id=cc_rcpt_4M460J4JCZVFQQTZ$/);
  });

  it("accepts the wrapped payload shape", async () => {
    const wrapped = { receipt: { ...RECEIPT_PAYLOAD, public_key: undefined }, public_key: "PUBKEY", verified: true };
    const { client } = makeClient(routed({ receipt: jsonResponse(200, wrapped) }));
    const receipt = await client.getReceipt("cc_rcpt_4M460J4JCZVFQQTZ");
    expect(receipt.id).toBe("cc_rcpt_4M460J4JCZVFQQTZ");
    expect(receipt.public_key).toBe("PUBKEY");
  });

  it.each(["", "   ", undefined, null, 42, "https://example.com/not-a-receipt", "two words"])(
    "rejects bad id %j before any request",
    async (bad) => {
      const { client, mock } = makeClient();
      await expect(client.getReceipt(bad as never)).rejects.toThrow(ValidationError);
      expect(mock.requests).toEqual([]);
    },
  );

  it("throws ReceiptNotFoundError on 404", async () => {
    const handler = routed({ receipt: jsonResponse(404, { error: "not_found", message: "No receipt has that id." }) });
    const { client } = makeClient(handler);
    const error = await client.getReceipt("cc_rcpt_MISSING").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReceiptNotFoundError);
    expect((error as ReceiptNotFoundError).status).toBe(404);
    expect((error as ReceiptNotFoundError).message).toBe("No receipt has that id.");
  });

  it("maps a receipt without an id to an error", async () => {
    const { client } = makeClient(routed({ receipt: jsonResponse(200, { signature: "x" }) }));
    await expect(client.getReceipt("cc_rcpt_X")).rejects.toThrow("receipt has no id");
  });
});

describe("health()", () => {
  it("reads the health pulse", async () => {
    const { client, mock } = makeClient();
    const health = await client.health();
    expect(health.status).toBe("ok");
    expect(health.checked_at).toBe(HEALTH_PAYLOAD.checked_at);
    expect([health.api_ok, health.mcp_ok, health.worker_ok]).toEqual([true, true, true]);
    expect(mock.last.url).toBe("https://precleared.dev/api/v1/health");
  });

  it("reports degraded status", async () => {
    const { client } = makeClient(routed({ health: jsonResponse(200, { status: "degraded", api_ok: true, mcp_ok: false }) }));
    const health = await client.health();
    expect(health.status).toBe("degraded");
    expect(health.mcp_ok).toBe(false);
    expect(health.worker_ok).toBeNull();
  });
});
