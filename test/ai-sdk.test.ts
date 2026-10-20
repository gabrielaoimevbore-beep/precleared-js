import { describe, expect, it, vi } from "vitest";

import { preclearedTools } from "../src/ai-sdk";
import { CHECK_DESCRIPTION, VERIFY_DESCRIPTION } from "../src/descriptions";
import { contactCheckInputSchema, verifyReceiptInputSchema } from "../src/schemas";

import { CONSENT_RECEIPT } from "./fixtures";
import { jsonResponse, makeClient, routed } from "./helpers";

// The "ai" package is not installed. This stands in for `tool()`, which in the
// AI SDK is an identity function that only exists for type inference.
vi.mock("ai", () => ({
  tool: vi.fn((definition: Record<string, unknown>) => ({ ...definition, __builtWithTool: true })),
}));

describe("precleared/ai-sdk", () => {
  it("builds both tools with tool() from ai", async () => {
    const { tool } = await import("ai");
    const { client } = makeClient();
    const tools = await preclearedTools(client);

    expect(Object.keys(tools)).toEqual(["contact_check", "verify_receipt"]);
    expect(vi.mocked(tool)).toHaveBeenCalledTimes(2);

    const check = tools.contact_check as unknown as Record<string, unknown>;
    expect(check.__builtWithTool).toBe(true);
    expect(check.description).toBe(CHECK_DESCRIPTION);
    expect(check.inputSchema).toBe(contactCheckInputSchema);
    expect(typeof check.execute).toBe("function");

    const verify = tools.verify_receipt as unknown as Record<string, unknown>;
    expect(verify.description).toBe(VERIFY_DESCRIPTION);
    expect(verify.inputSchema).toBe(verifyReceiptInputSchema);
  });

  it("execute runs a check through the client and returns compact text", async () => {
    const { client, mock } = makeClient();
    const tools = await preclearedTools(client);
    const input = contactCheckInputSchema.parse({ recipient_email: "jane@acme.co.uk", pitch: "Bookkeeping", address_source: "given" });
    const controller = new AbortController();

    const text = await tools.contact_check.execute!(input, { toolCallId: "call_1", messages: [], abortSignal: controller.signal });
    expect(text).toMatch(/^verdict: ok_to_email \(confidence: high\)/);
    expect(text).toContain("receipt: cc_rcpt_363BBFMQ3YNSKA6A https://precleared.dev/r/cc_rcpt_363BBFMQ3YNSKA6A");
    expect(mock.lastJson()).toMatchObject({ recipient_email: "jane@acme.co.uk", address_source: "given", pitch: "Bookkeeping" });
    expect(mock.last.signal).toBeDefined();
    expect(mock.header("authorization")).toBeUndefined();
  });

  it("execute fetches a receipt and reports API errors as text", async () => {
    const { client } = makeClient(routed({ receipt: jsonResponse(200, CONSENT_RECEIPT), check: jsonResponse(429, { error: "daily_limit", get_key_url: "https://precleared.dev/get-key" }) }));
    const tools = await preclearedTools(client);

    const receipt = await tools.verify_receipt.execute!({ receipt_id: "cc_rcpt_E21TTJV8D9JAYTQZ" }, { toolCallId: "c", messages: [] });
    expect(receipt).toMatch(/^receipt: cc_rcpt_E21TTJV8D9JAYTQZ/);

    const failed = await tools.contact_check.execute!(contactCheckInputSchema.parse({ recipient_domain: "acme.co.uk" }), { toolCallId: "c", messages: [] });
    expect(failed).toMatch(/^error: daily_limit/);
    expect(failed).toContain("get_key_url: https://precleared.dev/get-key");
  });

  it("returns objects with format json", async () => {
    const { client } = makeClient();
    const tools = await preclearedTools(client, { format: "json" });
    const out = await tools.contact_check.execute!(contactCheckInputSchema.parse({ recipient_email: "jane@acme.co.uk" }), { toolCallId: "c", messages: [] });
    expect(out).toMatchObject({ verdict: "ok_to_email", receipt_id: "cc_rcpt_363BBFMQ3YNSKA6A" });
  });
});
