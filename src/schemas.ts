/**
 * Zod schemas for the request fields, the schemas the framework tools expose
 * to the model, and `jsonSchema()` for people wiring their own agent.
 *
 * Works with zod 3.25 or later and zod 4. Only the API shared by both is used.
 */

import { z } from "zod/v4";

import {
  ARG_DESCRIPTIONS as D,
  CHECK_DESCRIPTION,
  CHECK_TOOL_NAME,
  VERIFY_DESCRIPTION,
  VERIFY_TOOL_NAME,
} from "./descriptions";
import { ADDRESS_SOURCES } from "./types";

export { CHECK_DESCRIPTION, CHECK_TOOL_NAME, VERIFY_DESCRIPTION, VERIFY_TOOL_NAME, ARG_DESCRIPTIONS } from "./descriptions";

const COUNTRY_CODE = /^[A-Z]{2}$/;

export const ADDRESS_SOURCE_MESSAGE = `address_source must be one of ${ADDRESS_SOURCES.join(", ")}`;
export const RECIPIENT_REQUIRED_MESSAGE = "recipient_email or recipient_domain is required";

function countryCode(name: string) {
  const message = `${name} must be a two-letter country code such as 'GB'`;
  return z.string({ message }).regex(COUNTRY_CODE, { message });
}

function flag(name: string) {
  return z.boolean({ message: `${name} must be true or false` });
}

function text(name: string) {
  return z.string({ message: `${name} must be a string` });
}

/**
 * The fields of `POST /api/v1/check`, as the client validates them before a
 * request. The client trims strings, lower-cases `address_source` and
 * upper-cases country codes first, so pass normalised values when you use
 * this schema on its own. Defaults (`address_source` unknown, `sender_country`
 * GB, `existing_customer` false) are applied by the client after parsing.
 */
export const checkInputSchema = z
  .object({
    recipient_email: text("recipient_email").optional(),
    recipient_domain: text("recipient_domain").optional(),
    pitch: text("pitch").optional(),
    address_source: z.enum(ADDRESS_SOURCES, { message: ADDRESS_SOURCE_MESSAGE }).optional(),
    sender_country: countryCode("sender_country").optional(),
    existing_customer: flag("existing_customer").optional(),
    pitch_relevant: flag("pitch_relevant").optional(),
    company_number: text("company_number").optional(),
    recipient_country: countryCode("recipient_country").optional(),
    default_recipient_country: countryCode("default_recipient_country").optional(),
    suppressed: flag("suppressed").optional(),
  })
  .refine((data) => Boolean(data.recipient_email || data.recipient_domain), {
    message: RECIPIENT_REQUIRED_MESSAGE,
    path: [],
  });

export type CheckInputFields = z.infer<typeof checkInputSchema>;

/**
 * What the model sees for `contact_check`. The same fields as the Python
 * SDK's tool, each with a description that tells the model how to fill it.
 */
export const contactCheckInputSchema = z.object({
  recipient_email: z.string().optional().describe(D.recipient_email),
  recipient_domain: z.string().optional().describe(D.recipient_domain),
  pitch: z.string().optional().describe(D.pitch),
  address_source: z.enum(ADDRESS_SOURCES).default("unknown").describe(D.address_source),
  existing_customer: z.boolean().default(false).describe(D.existing_customer),
  pitch_relevant: z.boolean().optional().describe(D.pitch_relevant),
  sender_country: z.string().default("GB").describe(D.sender_country),
  recipient_country: z.string().optional().describe(D.recipient_country),
  company_number: z.string().optional().describe(D.company_number),
  suppressed: z.boolean().optional().describe(D.suppressed),
});

/** What the model sees for `verify_receipt`. */
export const verifyReceiptInputSchema = z.object({
  receipt_id: z.string().describe(D.receipt_id),
});

export type ContactCheckInput = z.infer<typeof contactCheckInputSchema>;
export type VerifyReceiptInput = z.infer<typeof verifyReceiptInputSchema>;

/** A plain JSON Schema object (draft-07 subset). */
export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties: false;
}

export interface JsonSchemaProperty {
  type: "string" | "boolean";
  description: string;
  enum?: readonly string[];
  default?: string | boolean;
}

export interface ToolJsonSchema {
  /** Tool name: `contact_check` or `verify_receipt`. */
  name: string;
  /** Description that tells the model when to call the tool. */
  description: string;
  /** JSON Schema for the arguments. */
  parameters: JsonSchemaObject;
}

const CONTACT_CHECK_PARAMETERS: JsonSchemaObject = {
  type: "object",
  properties: {
    recipient_email: { type: "string", description: D.recipient_email },
    recipient_domain: { type: "string", description: D.recipient_domain },
    pitch: { type: "string", description: D.pitch },
    address_source: {
      type: "string",
      enum: [...ADDRESS_SOURCES],
      default: "unknown",
      description: D.address_source,
    },
    existing_customer: { type: "boolean", default: false, description: D.existing_customer },
    pitch_relevant: { type: "boolean", description: D.pitch_relevant },
    sender_country: { type: "string", default: "GB", description: D.sender_country },
    recipient_country: { type: "string", description: D.recipient_country },
    company_number: { type: "string", description: D.company_number },
    suppressed: { type: "boolean", description: D.suppressed },
  },
  additionalProperties: false,
};

const VERIFY_RECEIPT_PARAMETERS: JsonSchemaObject = {
  type: "object",
  properties: {
    receipt_id: { type: "string", description: D.receipt_id },
  },
  required: ["receipt_id"],
  additionalProperties: false,
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * The two tools as plain JSON Schema, for agent frameworks this package has no
 * helper for (OpenAI or Anthropic function calling, MCP servers, your own
 * loop). Pair it with `createToolHandlers()` from the main entry point to run
 * the calls. Each call returns fresh objects you can change freely.
 */
export function jsonSchema(): { contact_check: ToolJsonSchema; verify_receipt: ToolJsonSchema } {
  return {
    contact_check: {
      name: CHECK_TOOL_NAME,
      description: CHECK_DESCRIPTION,
      parameters: clone(CONTACT_CHECK_PARAMETERS),
    },
    verify_receipt: {
      name: VERIFY_TOOL_NAME,
      description: VERIFY_DESCRIPTION,
      parameters: clone(VERIFY_RECEIPT_PARAMETERS),
    },
  };
}
