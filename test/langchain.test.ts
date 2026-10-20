import { describe, expect, it, vi } from "vitest";

import { CHECK_DESCRIPTION, VERIFY_DESCRIPTION } from "../src/descriptions";
import { preclearedTools } from "../src/langchain";
import { contactCheckInputSchema, verifyReceiptInputSchema } from "../src/schemas";

import { CONSENT_PAYLOAD, CONSENT_RECEIPT, KEY } from "./fixtures";
import { jsonResponse, makeClient, routed } from "./helpers";

interface Fields {
  name: string;
  description: string;
  schema: { parse(value: unknown): unknown };
  func: (input: unknown, runManager?: unknown, config?: { signal?: AbortSignal }) => Promise<unknown>;
}

// @langchain/core is not installed. This stands in for DynamicStructuredTool:
// it keeps the fields and runs `func` from `invoke`, as the real class does
// after validating the input against `schema`.
vi.mock("@langchain/core/tools", () => ({
  DynamicStructuredTool: class {
    name: string;
    description: string;
    schema: Fields["schema"];
    func: Fields["func"];
    constructor(fields: Fields) {
      this.name = fields.name;
      this.description = fields.description;
      this.schema = fields.schema;
      this.func = fields.func;
    }
    invoke(input: unknown, config?: { signal?: AbortSignal }) {
      return this.func(this.schema.parse(input), undefined, config);
    }
  },
}));

type StubTool = Fields & { invoke(input: unknown, config?: { signal?: AbortSignal }): Promise<unknown> };

describe("precleared/langchain", () => {
  it("builds both tools as DynamicStructuredTool instances", async () => {
    const { DynamicStructuredTool } = await import("@langchain/core/tools");
    const { client } = makeClient();
    const tools = (await preclearedTools(client)) as unknown as StubTool[];

    expect(tools).toHaveLength(2);
    expect(tools[0]).toBeInstanceOf(DynamicStructuredTool);
    expect(tools[1]).toBeInstanceOf(DynamicStructuredTool);
    expect(tools.map((tool) => tool.name)).toEqual(["contact_check", "verify_receipt"]);
    expect(tools[0]?.description).toBe(CHECK_DESCRIPTION);
    expect(tools[1]?.description).toBe(VERIFY_DESCRIPTION);
    expect(tools[0]?.schema).toBe(contactCheckInputSchema);
    expect(tools[1]?.schema).toBe(verifyReceiptInputSchema);
  });

  it("invoke returns compact text and passes the config signal on", async () => {
    const { client, mock } = makeClient(undefined, { apiKey: KEY });
    const [check] = (await preclearedTools(client)) as unknown as StubTool[];
    const controller = new AbortController();

    const text = await check!.invoke({ recipient_email: "jane@acme.co.uk", pitch: "Bookkeeping software" }, { signal: controller.signal });
    expect(text).toMatch(/^verdict: ok_to_email \(confidence: high\)/);
    expect(text).toContain("receipt: cc_rcpt_363BBFMQ3YNSKA6A https://precleared.dev/r/cc_rcpt_363BBFMQ3YNSKA6A");
    expect(mock.lastJson().address_source).toBe("unknown");
    expect(mock.header("authorization")).toBe(`Bearer ${KEY}`);
    expect(mock.last.signal).toBeDefined();
    expect(JSON.stringify(check)).not.toContain(KEY);
  });

  it("verify_receipt and error text", async () => {
    const { client } = makeClient(
      routed({ receipt: jsonResponse(200, CONSENT_RECEIPT), check: jsonResponse(200, CONSENT_PAYLOAD) }),
    );
    const [check, verify] = (await preclearedTools(client)) as unknown as StubTool[];

    expect(await verify!.invoke({ receipt_id: "cc_rcpt_E21TTJV8D9JAYTQZ" })).toMatch(/^receipt: cc_rcpt_E21TTJV8D9JAYTQZ/);
    expect(await check!.invoke({ recipient_email: "bob@soletrader.co.uk" })).toMatch(/^verdict: consent_needed/);

    const limited = makeClient(routed({ check: jsonResponse(429, { error: "daily_limit", get_key_url: "https://precleared.dev/get-key" }) }));
    const [limitedCheck] = (await preclearedTools(limited.client)) as unknown as StubTool[];
    const text = await limitedCheck!.invoke({ recipient_email: "jane@acme.co.uk" });
    expect(text).toMatch(/^error: daily_limit/);
    expect(text).toContain("get_key_url: https://precleared.dev/get-key");
  });

  it("returns objects with format json", async () => {
    const { client } = makeClient();
    const [check] = (await preclearedTools(client, { format: "json" })) as unknown as StubTool[];
    expect(await check!.invoke({ recipient_email: "jane@acme.co.uk" })).toMatchObject({ verdict: "ok_to_email" });
  });
});
