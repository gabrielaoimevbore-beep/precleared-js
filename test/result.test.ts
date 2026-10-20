import { describe, expect, it } from "vitest";

import {
  decidingReason,
  describeReason,
  normaliseCheckResult,
  normaliseReceipt,
  normaliseReceiptId,
  parseRetryAfter,
  receiptFromPayload,
  receiptSummary,
  receiptSummaryText,
  receiptUrl,
  summary,
  summaryText,
  ValidationError,
} from "../src/index";

import { CONSENT_PAYLOAD, CONSENT_RECEIPT, OK_PAYLOAD, RECEIPT_PAYLOAD, UNKNOWN_PAYLOAD } from "./fixtures";

describe("parseRetryAfter", () => {
  it.each([
    [12, null, 12],
    [0.5, null, 0.5],
    ["30", null, 30],
    [null, "7", 7],
    [null, " 7 ", 7],
    [null, "0", 0],
    [null, "-5", 0],
    [-3, null, 0],
    [null, null, undefined],
    [null, "", undefined],
    [null, "soon", undefined],
    ["soon", "9", 9],
    [true, "9", 9],
    [12, "99", 12],
  ])("parseRetryAfter(%j, %j) is %j", (body, header, expected) => {
    expect(parseRetryAfter(body, header)).toBe(expected);
  });

  it("turns an HTTP-date into seconds from now", () => {
    const future = new Date(Date.now() + 120_000).toUTCString();
    const seconds = parseRetryAfter(null, future) as number;
    expect(seconds).toBeGreaterThanOrEqual(110);
    expect(seconds).toBeLessThanOrEqual(121);
    const past = new Date(Date.now() - 120_000).toUTCString();
    expect(parseRetryAfter(null, past)).toBe(0);
  });
});

describe("normaliseReceiptId", () => {
  it.each([
    ["cc_rcpt_ABC123", "cc_rcpt_ABC123"],
    ["  cc_rcpt_ABC123\n", "cc_rcpt_ABC123"],
    ["https://precleared.dev/r/cc_rcpt_ABC123", "cc_rcpt_ABC123"],
    ["https://precleared.dev/api/v1/receipt?id=cc_rcpt_ABC123", "cc_rcpt_ABC123"],
    ["legacy_id_without_prefix", "legacy_id_without_prefix"],
  ])("%j becomes %j", (value, expected) => {
    expect(normaliseReceiptId(value)).toBe(expected);
  });

  it.each(["", "  ", null, undefined, 42, "https://example.com/x", "two words"])("rejects %j", (value) => {
    expect(() => normaliseReceiptId(value)).toThrow(ValidationError);
  });
});

describe("receiptUrl", () => {
  it("takes an id, a receipt or a result", () => {
    expect(receiptUrl("cc_rcpt_X")).toBe("https://precleared.dev/r/cc_rcpt_X");
    expect(receiptUrl(normaliseReceipt(RECEIPT_PAYLOAD))).toBe("https://precleared.dev/r/cc_rcpt_4M460J4JCZVFQQTZ");
    expect(receiptUrl(normaliseCheckResult(OK_PAYLOAD))).toBe("https://precleared.dev/r/cc_rcpt_363BBFMQ3YNSKA6A");
    expect(receiptUrl(normaliseCheckResult({ ...OK_PAYLOAD, receipt: null }))).toBeNull();
    expect(receiptUrl(null)).toBeNull();
    expect(receiptUrl("cc_rcpt_X", "https://example.test/")).toBe("https://example.test/r/cc_rcpt_X");
  });
});

describe("reasons", () => {
  it.each([
    [{ text: "T", source_title: "S", source_url: "U" }, "T Source: S, U"],
    [{ text: "T", source_url: "U" }, "T Source: U"],
    [{ text: "T", source_title: "S" }, "T Source: S"],
    [{ note: "N" }, "N"],
    [{}, ""],
  ])("describeReason(%j)", (reason, expected) => {
    expect(describeReason(reason)).toBe(expected);
  });

  it("finds the deciding reason and ignores notes", () => {
    const result = normaliseCheckResult(CONSENT_PAYLOAD);
    expect(decidingReason(result)?.rule_key).toBe("gb_individual_consent");
    expect(decidingReason(normaliseCheckResult({ verdict: "unknown", reasons: [{ note: "n" }] }))).toBeNull();
  });
});

describe("summaries", () => {
  it("summary() has what a sending agent needs", () => {
    const out = summary(normaliseCheckResult(OK_PAYLOAD));
    expect(out).toEqual({
      verdict: "ok_to_email",
      confidence: "high",
      rule: "us_canspam_ok",
      reason: OK_PAYLOAD.reasons[0]?.text,
      source_title: "FTC CAN-SPAM Act compliance guide for business",
      source_url: "https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business",
      notes: [],
      footer_text: OK_PAYLOAD.footer_text,
      next_step: OK_PAYLOAD.next_step,
      receipt_id: "cc_rcpt_363BBFMQ3YNSKA6A",
      receipt_url: "https://precleared.dev/r/cc_rcpt_363BBFMQ3YNSKA6A",
      free_remaining_today: 24,
      credits_remaining: 0,
      disclaimer: OK_PAYLOAD.disclaimer,
    });
  });

  it("summaryText() matches the Python SDK's layout for the live consent sample", () => {
    const lines = summaryText(normaliseCheckResult(CONSENT_PAYLOAD)).split("\n");
    expect(lines[0]).toBe("verdict: consent_needed (confidence: medium)");
    expect(lines[1]).toBe("rule: gb_individual_consent");
    expect(lines[2]).toMatch(/^reason: The recipient is a sole trader/);
    expect(lines[2]).toMatch(/Source: PECR 2003 regulation 22\(2\) and ICO Guide to PECR, https:\/\/www\.legislation\.gov\.uk\/uksi\/2003\/2426\/regulation\/22$/);
    expect(lines[3]).toBe("note: Legal form came from the company website.");
    expect(lines[4]).toBe("next_step: Do not cold email. Use a route they offer, such as their contact form, or obtain consent first.");
    expect(lines[5]).toBe("receipt: cc_rcpt_E21TTJV8D9JAYTQZ https://precleared.dev/r/cc_rcpt_E21TTJV8D9JAYTQZ");
    expect(lines).toHaveLength(6);
    expect(summaryText(normaliseCheckResult(CONSENT_PAYLOAD))).not.toContain("footer_text");
  });

  it("summaryText() includes footer_text for ok_to_email and handles missing parts", () => {
    const text = summaryText(normaliseCheckResult(OK_PAYLOAD));
    expect(text).toContain("footer_text: Truthful From and subject line");
    expect(text).toContain("next_step: Send. Log the receipt against the lead.");

    const bare = summaryText(normaliseCheckResult({ verdict: "unknown" }));
    expect(bare).toBe("verdict: unknown");

    const unknown = summaryText(normaliseCheckResult(UNKNOWN_PAYLOAD));
    expect(unknown.split("\n")[0]).toBe("verdict: unknown (confidence: low)");
    expect(unknown).toContain("rule: any_no_mx");
  });

  it("receipt summaries leave the public key out", () => {
    const receipt = receiptFromPayload(CONSENT_RECEIPT);
    const out = receiptSummary(receipt);
    expect(out.receipt_id).toBe("cc_rcpt_E21TTJV8D9JAYTQZ");
    expect(out.verdict).toBe("consent_needed");
    expect(out.rules_applied).toEqual(["gb_individual_consent"]);
    expect(out).not.toHaveProperty("public_key");
    expect(out).not.toHaveProperty("verify_url");

    const text = receiptSummaryText(receipt);
    expect(text.split("\n")[0]).toBe("receipt: cc_rcpt_E21TTJV8D9JAYTQZ");
    expect(text).toContain("rules_applied: gb_individual_consent");
    expect(text).toContain(`signature: ${CONSENT_RECEIPT.signature}`);
    expect(text).not.toContain("public_key");
  });

  it("receipt summary skips empty values", () => {
    const receipt = normaliseReceipt({ receipt_id: "cc_rcpt_X", signature: "s", key_version: "v2", rules_applied: [] });
    expect(receipt.id).toBe("cc_rcpt_X");
    expect(receiptSummary(receipt)).toEqual({ receipt_id: "cc_rcpt_X", signature: "s", key_version: "v2" });
    expect(receiptSummaryText(receipt)).toBe("receipt: cc_rcpt_X\nsignature: s\nkey_version: v2");
  });

  it("normaliseReceipt rejects non-objects and missing ids", () => {
    expect(() => normaliseReceipt(["not", "a", "dict"])).toThrow(ValidationError);
    expect(() => normaliseReceipt({ signature: "x" })).toThrow("receipt has no id");
  });
});
