/**
 * Precleared tools for Mastra (`@mastra/core`).
 *
 *     import { Agent } from "@mastra/core/agent";
 *     import { Precleared } from "precleared";
 *     import { preclearedTools } from "precleared/mastra";
 *
 *     const client = new Precleared({ apiKey: process.env.PRECLEARED_API_KEY });
 *     export const sdr = new Agent({
 *       name: "SDR",
 *       instructions: "Check every address before the first email.",
 *       model,
 *       tools: await preclearedTools(client),
 *     });
 *
 * `@mastra/core/tools` is loaded when `preclearedTools()` is called, not when
 * this module is imported. Works with Mastra 0.x (`execute({ context })`) and
 * Mastra 1.x (`execute(inputData, context)`).
 */

import { z } from "zod/v4";
import type { createTool } from "@mastra/core/tools";

import type { Precleared } from "./client";
import { CHECK_DESCRIPTION, CHECK_TOOL_NAME, VERIFY_DESCRIPTION, VERIFY_TOOL_NAME } from "./descriptions";
import { loadPeer } from "./peer";
import { isRecord } from "./result";
import { contactCheckInputSchema, verifyReceiptInputSchema } from "./schemas";
import { createToolHandlers, type ContactCheckArgs, type ToolFormat, type ToolOptions, type VerifyReceiptArgs } from "./tools";

export type { ToolFormat, ToolOptions } from "./tools";

/** A tool as `createTool()` from `@mastra/core/tools` returns it. */
export type MastraTool = ReturnType<typeof createTool>;

/** The two tools, keyed by id, ready for `new Agent({ tools })`. */
// A type alias, not an interface, so it is assignable to index-signature types such as an agent's tools record.
export type PreclearedMastraTools = {
  contact_check: MastraTool;
  verify_receipt: MastraTool;
};

const INPUT_KEYS = ["recipient_email", "recipient_domain", "receipt_id", "pitch", "address_source"];

/**
 * Mastra 0.x calls `execute({ context, runtimeContext, ... })`, where `context`
 * holds the parsed input. Mastra 1.x calls `execute(inputData, context)`.
 * Neither tool schema has a `context` field, so an object that carries one
 * (and none of our input fields) is the 0.x wrapper.
 */
export function unwrapMastraInput(first: unknown): unknown {
  if (isRecord(first) && isRecord(first.context) && !INPUT_KEYS.some((key) => key in first)) {
    return first.context;
  }
  return first;
}

function abortSignalFrom(...candidates: unknown[]): AbortSignal | undefined {
  for (const candidate of candidates) {
    if (isRecord(candidate) && candidate.abortSignal instanceof AbortSignal) return candidate.abortSignal;
  }
  return undefined;
}

/**
 * Build `contact_check` and `verify_receipt` with `createTool()` from
 * `@mastra/core/tools`, bound to one client. Returns compact text by default
 * (`outputSchema` is a string); pass `{ format: "json" }` for objects.
 */
export async function preclearedTools<F extends ToolFormat = "text">(
  client: Precleared,
  options: ToolOptions<F> = {},
): Promise<PreclearedMastraTools> {
  const { createTool } = await loadPeer(
    "precleared/mastra",
    "@mastra/core",
    "version 0.10 or later",
    () => import("@mastra/core/tools"),
  );
  const handlers = createToolHandlers(client, options);
  const outputSchema = options.format === "json" ? z.record(z.string(), z.unknown()) : z.string();

  return {
    contact_check: createTool({
      id: CHECK_TOOL_NAME,
      description: CHECK_DESCRIPTION,
      inputSchema: contactCheckInputSchema,
      outputSchema,
      execute: async (first, second) =>
        handlers.contact_check(unwrapMastraInput(first) as ContactCheckArgs, { signal: abortSignalFrom(second, first) }),
    }),
    verify_receipt: createTool({
      id: VERIFY_TOOL_NAME,
      description: VERIFY_DESCRIPTION,
      inputSchema: verifyReceiptInputSchema,
      outputSchema,
      execute: async (first, second) =>
        handlers.verify_receipt(unwrapMastraInput(first) as VerifyReceiptArgs, { signal: abortSignalFrom(second, first) }),
    }),
  };
}
