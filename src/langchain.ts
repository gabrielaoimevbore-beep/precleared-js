/**
 * Precleared tools for LangChain.js and LangGraph.js (`@langchain/core`).
 *
 *     import { createAgent } from "langchain";
 *     import { Precleared } from "precleared";
 *     import { preclearedTools } from "precleared/langchain";
 *
 *     const client = new Precleared({ apiKey: process.env.PRECLEARED_API_KEY });
 *     const agent = createAgent({ model, tools: await preclearedTools(client) });
 *
 * `@langchain/core/tools` is loaded when `preclearedTools()` is called, not
 * when this module is imported.
 */

import type { DynamicStructuredTool } from "@langchain/core/tools";

import type { Precleared } from "./client";
import { CHECK_DESCRIPTION, CHECK_TOOL_NAME, VERIFY_DESCRIPTION, VERIFY_TOOL_NAME } from "./descriptions";
import { loadPeer } from "./peer";
import { contactCheckInputSchema, verifyReceiptInputSchema } from "./schemas";
import { createToolHandlers, type ContactCheckArgs, type ToolFormat, type ToolOptions, type VerifyReceiptArgs } from "./tools";

export type { ToolFormat, ToolOptions } from "./tools";

/** `[contact_check, verify_receipt]`, ready for an agent's `tools` list or `model.bindTools()`. */
export type PreclearedLangChainTools = [DynamicStructuredTool, DynamicStructuredTool];

/**
 * Build `contact_check` and `verify_receipt` as `DynamicStructuredTool`s,
 * bound to one client. Each returns compact text by default; pass
 * `{ format: "json" }` for objects.
 */
export async function preclearedTools<F extends ToolFormat = "text">(
  client: Precleared,
  options: ToolOptions<F> = {},
): Promise<PreclearedLangChainTools> {
  const { DynamicStructuredTool } = await loadPeer(
    "precleared/langchain",
    "@langchain/core",
    "version 0.3 or later",
    () => import("@langchain/core/tools"),
  );
  const handlers = createToolHandlers(client, options);

  const contactCheck = new DynamicStructuredTool({
    name: CHECK_TOOL_NAME,
    description: CHECK_DESCRIPTION,
    schema: contactCheckInputSchema,
    func: (input, _runManager, config) => handlers.contact_check(input as ContactCheckArgs, { signal: config?.signal }),
  });

  const verifyReceipt = new DynamicStructuredTool({
    name: VERIFY_TOOL_NAME,
    description: VERIFY_DESCRIPTION,
    schema: verifyReceiptInputSchema,
    func: (input, _runManager, config) => handlers.verify_receipt(input as VerifyReceiptArgs, { signal: config?.signal }),
  });

  return [contactCheck, verifyReceipt];
}
