/**
 * The framework-neutral layer behind the Vercel AI SDK, Mastra and LangChain
 * helpers: two functions, `contact_check` and `verify_receipt`, bound to one
 * client. They never throw for an API failure. They return an error
 * description instead, so the model can react (wait, get a key, fix an
 * argument) rather than crash the run. Bad arguments are reported the same way.
 *
 * Use this directly when you wire your own agent loop: pair it with
 * `jsonSchema()` from `precleared/schemas`.
 */

import type { Precleared, RequestOptions } from "./client";
import { isPreclearedError, type PaymentRequiredError, type RateLimitError } from "./errors";
import { receiptSummary, receiptSummaryText, receiptUrl, summary, summaryText, type CheckSummary, type ReceiptSummary } from "./result";
import type { CheckInput } from "./types";

export type ToolFormat = "text" | "json";

export interface ToolOptions<F extends ToolFormat = "text"> {
  /**
   * `text` (default) returns compact lines the model reads directly:
   * verdict, rule, footer_text, next_step and the receipt URL.
   * `json` returns the same facts as an object.
   */
  format?: F;
}

/** Arguments for `contact_check`, as a model sends them. Booleans may arrive as strings. */
export interface ContactCheckArgs {
  recipient_email?: string | null;
  recipient_domain?: string | null;
  pitch?: string | null;
  address_source?: string | null;
  existing_customer?: boolean | string | number | null;
  pitch_relevant?: boolean | string | number | null;
  sender_country?: string | null;
  recipient_country?: string | null;
  company_number?: string | number | null;
  suppressed?: boolean | string | number | null;
}

/** Arguments for `verify_receipt`. */
export interface VerifyReceiptArgs {
  receipt_id: string;
}

/** Structured description of a failure, safe to hand to a model. */
export interface ToolErrorPayload {
  error: string;
  message: string;
  status_code?: number;
  retry_after?: number;
  buy_url?: string;
  get_key_url?: string;
}

export type CheckToolOutput<F extends ToolFormat> = F extends "json" ? CheckSummary | ToolErrorPayload : string;
export type VerifyToolOutput<F extends ToolFormat> = F extends "json" ? ReceiptSummary | ToolErrorPayload : string;

export interface ToolHandlers<F extends ToolFormat = "text"> {
  /** Run one check. Returns compact text, or an object when `format` is `json`. */
  contact_check(args: ContactCheckArgs, options?: RequestOptions): Promise<CheckToolOutput<F>>;
  /** Fetch one receipt. Returns compact text, or an object when `format` is `json`. */
  verify_receipt(args: VerifyReceiptArgs, options?: RequestOptions): Promise<VerifyToolOutput<F>>;
}

const TRUE = new Set(["true", "yes", "y", "1", "on"]);
const FALSE = new Set(["false", "no", "n", "0", "off"]);

/** Models sometimes send booleans as strings. Accept the obvious forms. */
export function coerceBool(value: unknown, name: string): boolean | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && (value === 0 || value === 1)) return value === 1;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (text === "") return undefined;
    if (TRUE.has(text)) return true;
    if (FALSE.has(text)) return false;
  }
  throw new Error(`${name} must be true or false, got ${JSON.stringify(value)}`);
}

function blankToUndefined(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  return text === "" ? undefined : text;
}

/** Structured description of a failure, safe to hand to a model. */
export function errorPayload(error: unknown): ToolErrorPayload {
  if (isPreclearedError(error)) {
    const payload: ToolErrorPayload = {
      error: error.code ?? error.name,
      message: error.message,
    };
    if (error.status !== undefined) payload.status_code = error.status;
    // Read the extras by field rather than by class, so a second copy of this
    // package (a bundler duplicating it) is still described correctly.
    const extras = error as Partial<RateLimitError & PaymentRequiredError>;
    if (typeof extras.retryAfter === "number") payload.retry_after = extras.retryAfter;
    if (typeof extras.getKeyUrl === "string" && extras.getKeyUrl) payload.get_key_url = extras.getKeyUrl;
    if (typeof extras.buyUrl === "string" && extras.buyUrl) payload.buy_url = extras.buyUrl;
    return payload;
  }
  const message = error instanceof Error ? error.message : String(error);
  return { error: "invalid_arguments", message };
}

/** The error payload as lines of text, ending with an instruction not to send. */
export function formatError(payload: ToolErrorPayload): string {
  const lines = [`error: ${payload.error}`, `message: ${payload.message}`];
  for (const key of ["retry_after", "buy_url", "get_key_url"] as const) {
    if (payload[key] !== undefined) lines.push(`${key}: ${String(payload[key])}`);
  }
  lines.push("Do not send until a check succeeds.");
  return lines.join("\n");
}

/** Normalise what a model sent into a `CheckInput`. Throws on an unusable boolean. */
export function checkInputFromArgs(args: ContactCheckArgs): CheckInput {
  const input: CheckInput = {
    recipient_email: blankToUndefined(args.recipient_email),
    recipient_domain: blankToUndefined(args.recipient_domain),
    pitch: blankToUndefined(args.pitch),
    address_source: (blankToUndefined(args.address_source) ?? "unknown") as CheckInput["address_source"],
    sender_country: blankToUndefined(args.sender_country) ?? "GB",
    existing_customer: coerceBool(args.existing_customer, "existing_customer") ?? false,
    pitch_relevant: coerceBool(args.pitch_relevant, "pitch_relevant"),
    company_number: blankToUndefined(args.company_number),
    recipient_country: blankToUndefined(args.recipient_country),
    suppressed: coerceBool(args.suppressed, "suppressed"),
  };
  return input;
}

/**
 * The two tool functions, bound to one client. Every framework helper is a
 * thin wrapper around this.
 */
export function createToolHandlers<F extends ToolFormat = "text">(
  client: Precleared,
  options: ToolOptions<F> = {},
): ToolHandlers<F> {
  const json = options.format === "json";

  // API and validation errors become text. Anything else (a bug, an abort
  // requested by the caller) keeps propagating.
  const failure = (error: unknown): ToolErrorPayload | string => {
    if (!isPreclearedError(error)) throw error;
    const payload = errorPayload(error);
    return json ? payload : formatError(payload);
  };

  return {
    async contact_check(args, requestOptions) {
      let input: CheckInput;
      try {
        input = checkInputFromArgs(args ?? {});
      } catch (error) {
        const payload = errorPayload(error);
        return (json ? payload : formatError(payload)) as CheckToolOutput<F>;
      }
      try {
        const result = await client.check(input, requestOptions);
        return (json ? summary(result, client.baseUrl) : summaryText(result, client.baseUrl)) as CheckToolOutput<F>;
      } catch (error) {
        return failure(error) as CheckToolOutput<F>;
      }
    },

    async verify_receipt(args, requestOptions) {
      try {
        const receipt = await client.getReceipt(args?.receipt_id as string, requestOptions);
        const url = receiptUrl(receipt, client.baseUrl) as string;
        if (json) return { ...receiptSummary(receipt), receipt_url: url } as VerifyToolOutput<F>;
        return `${receiptSummaryText(receipt)}\nreceipt_url: ${url}` as VerifyToolOutput<F>;
      } catch (error) {
        return failure(error) as VerifyToolOutput<F>;
      }
    },
  };
}
