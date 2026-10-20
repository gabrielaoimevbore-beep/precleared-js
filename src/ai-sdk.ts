/**
 * Precleared tools for the Vercel AI SDK (`ai` version 5 or later).
 *
 *     import { generateText } from "ai";
 *     import { Precleared } from "precleared";
 *     import { preclearedTools } from "precleared/ai-sdk";
 *
 *     const client = new Precleared({ apiKey: process.env.PRECLEARED_API_KEY });
 *     const result = await generateText({
 *       model,
 *       tools: await preclearedTools(client),
 *       prompt: "Can I cold email jane@acme.co.uk about bookkeeping software?",
 *     });
 *
 * The `ai` package is loaded when `preclearedTools()` is called, not when
 * this module is imported, so the main `precleared` entry never depends on it.
 */

import type { Tool } from "ai";

import type { Precleared } from "./client";
import { CHECK_DESCRIPTION, VERIFY_DESCRIPTION } from "./descriptions";
import { loadPeer } from "./peer";
import { contactCheckInputSchema, verifyReceiptInputSchema, type ContactCheckInput, type VerifyReceiptInput } from "./schemas";
import { createToolHandlers, type CheckToolOutput, type ToolFormat, type ToolOptions, type VerifyToolOutput } from "./tools";

export type { ToolFormat, ToolOptions } from "./tools";

/** The two tools, keyed by name, ready for `generateText({ tools })` or `streamText({ tools })`. */
// A type alias, not an interface, so it is assignable to index-signature types such as ai's ToolSet.
export type PreclearedAiSdkTools<F extends ToolFormat = "text"> = {
  contact_check: Tool<ContactCheckInput, CheckToolOutput<F>>;
  verify_receipt: Tool<VerifyReceiptInput, VerifyToolOutput<F>>;
};

/**
 * Build `contact_check` and `verify_receipt` with `tool()` from the `ai`
 * package, bound to one client. Returns compact text by default; pass
 * `{ format: "json" }` for objects.
 */
export async function preclearedTools<F extends ToolFormat = "text">(
  client: Precleared,
  options: ToolOptions<F> = {},
): Promise<PreclearedAiSdkTools<F>> {
  const { tool } = await loadPeer("precleared/ai-sdk", "ai", "version 5 or later", () => import("ai"));
  const handlers = createToolHandlers(client, options);

  return {
    contact_check: tool<ContactCheckInput, CheckToolOutput<F>>({
      description: CHECK_DESCRIPTION,
      inputSchema: contactCheckInputSchema,
      execute: (input, executionOptions) => handlers.contact_check(input, { signal: executionOptions?.abortSignal }),
    }),
    verify_receipt: tool<VerifyReceiptInput, VerifyToolOutput<F>>({
      description: VERIFY_DESCRIPTION,
      inputSchema: verifyReceiptInputSchema,
      execute: (input, executionOptions) => handlers.verify_receipt(input, { signal: executionOptions?.abortSignal }),
    }),
  };
}
