import { describe, expect, it, vi } from "vitest";

import { CHECK_DESCRIPTION, VERIFY_DESCRIPTION } from "../src/descriptions";
import { preclearedTools, unwrapMastraInput } from "../src/mastra";
import { contactCheckInputSchema, verifyReceiptInputSchema } from "../src/schemas";

import { CONSENT_RECEIPT } from "./fixtures";
import { jsonResponse, makeClient, routed } from "./helpers";

interface StubTool {
  id: string;
  description: string;
  inputSchema: unknown;
  outputSchema: { parse(value: unknown): unknown };
  execute: (first: unknown, second?: unknown) => Promise<unknown>;
  __builtWithCreateTool: true;
}

// @mastra/core is not installed. This stands in for createTool(), which wraps
// the definition in a Tool instance.
vi.mock("@mastra/core/tools", () => ({
  createTool: vi.fn((definition: Record<string, unknown>) => ({ ...definition, __builtWithCreateTool: true })),
}));

describe("precleared/mastra", () => {
  it("builds both tools with createTool() from @mastra/core/tools", async () => {
    const { createTool } = await import("@mastra/core/tools");
    const { client } = makeClient();
    const tools = (await preclearedTools(client)) as unknown as { contact_check: StubTool; verify_receipt: StubTool };

    expect(Object.keys(tools)).toEqual(["contact_check", "verify_receipt"]);
    expect(vi.mocked(createTool)).toHaveBeenCalledTimes(2);

    expect(tools.contact_check.__builtWithCreateTool).toBe(true);
    expect(tools.contact_check.id).toBe("contact_check");
    expect(tools.contact_check.description).toBe(CHECK_DESCRIPTION);
    expect(tools.contact_check.inputSchema).toBe(contactCheckInputSchema);
    expect(tools.contact_check.outputSchema.parse("text")).toBe("text");
    expect(() => tools.contact_check.outputSchema.parse({ not: "text" })).toThrow();

    expect(tools.verify_receipt.id).toBe("verify_receipt");
    expect(tools.verify_receipt.description).toBe(VERIFY_DESCRIPTION);
    expect(tools.verify_receipt.inputSchema).toBe(verifyReceiptInputSchema);
  });

  it("execute(inputData, context) works (Mastra 1.x)", async () => {
    const { client, mock } = makeClient();
    const tools = (await preclearedTools(client)) as unknown as { contact_check: StubTool; verify_receipt: StubTool };
    const controller = new AbortController();

    const text = await tools.contact_check.execute(
      contactCheckInputSchema.parse({ recipient_email: "jane@acme.co.uk", address_source: "bought" }),
      { abortSignal: controller.signal, requestContext: {} },
    );
    expect(text).toMatch(/^verdict: ok_to_email/);
    expect(mock.lastJson()).toMatchObject({ recipient_email: "jane@acme.co.uk", address_source: "bought" });
    expect(mock.last.signal).toBeDefined();
  });

  it("execute({ context }) works (Mastra 0.x)", async () => {
    const { client, mock } = makeClient(routed({ receipt: jsonResponse(200, CONSENT_RECEIPT) }));
    const tools = (await preclearedTools(client)) as unknown as { contact_check: StubTool; verify_receipt: StubTool };

    const text = await tools.contact_check.execute({
      context: contactCheckInputSchema.parse({ recipient_domain: "acme.co.uk" }),
      runtimeContext: new Map(),
      mastra: {},
    });
    expect(text).toMatch(/^verdict: ok_to_email/);
    expect(mock.lastJson()).toMatchObject({ recipient_domain: "acme.co.uk", address_source: "unknown" });

    const receipt = await tools.verify_receipt.execute({ context: { receipt_id: "cc_rcpt_E21TTJV8D9JAYTQZ" } });
    expect(receipt).toMatch(/^receipt: cc_rcpt_E21TTJV8D9JAYTQZ/);
  });

  it("unwrapMastraInput tells the two shapes apart", () => {
    expect(unwrapMastraInput({ context: { recipient_email: "a@b.co" }, runtimeContext: {} })).toEqual({ recipient_email: "a@b.co" });
    expect(unwrapMastraInput({ recipient_email: "a@b.co" })).toEqual({ recipient_email: "a@b.co" });
    expect(unwrapMastraInput({ receipt_id: "cc_rcpt_X", context: {} })).toEqual({ receipt_id: "cc_rcpt_X", context: {} });
    expect(unwrapMastraInput({ context: {} })).toEqual({});
    expect(unwrapMastraInput(undefined)).toBeUndefined();
  });

  it("reports errors as text and supports format json with a record output schema", async () => {
    const { client } = makeClient(routed({ check: jsonResponse(402, { error: "payment_required", buy_url: "https://precleared.dev/buy" }) }));
    const textTools = (await preclearedTools(client)) as unknown as { contact_check: StubTool };
    const failed = await textTools.contact_check.execute({ recipient_email: "jane@acme.co.uk" });
    expect(failed).toMatch(/^error: payment_required/);
    expect(failed).toContain("buy_url: https://precleared.dev/buy");

    const jsonTools = (await preclearedTools(client, { format: "json" })) as unknown as { contact_check: StubTool };
    const out = await jsonTools.contact_check.execute({ recipient_email: "jane@acme.co.uk" });
    expect(out).toMatchObject({ error: "payment_required", buy_url: "https://precleared.dev/buy", status_code: 402 });
    expect(jsonTools.contact_check.outputSchema.parse(out)).toEqual(out);
  });
});
