/**
 * Precleared: a cold-email legality check for AI agents.
 *
 *     import { Precleared } from "precleared";
 *
 *     const client = new Precleared({ apiKey: process.env.PRECLEARED_API_KEY });
 *     const result = await client.check({ recipient_email: "jane@acme.co.uk", pitch: "Bookkeeping software" });
 *     if (result.verdict === "ok_to_email") send(result.footer_text);
 *
 * Decision support with sources, not legal advice.
 *
 * Framework helpers live in their own entry points so this one never loads a
 * framework: `precleared/ai-sdk`, `precleared/mastra`, `precleared/langchain`.
 * The zod schemas and `jsonSchema()` are in `precleared/schemas`.
 */

export { VERSION } from "./version";

export {
  Precleared,
  buildCheckBody,
  errorFromResponse,
  parseRetryAfter,
  DEFAULT_RETRIES,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_USER_AGENT,
  ENV_API_KEY,
} from "./client";
export type { FetchLike, FetchRequestInit, FetchResponseLike, PreclearedOptions, RequestOptions } from "./client";

export {
  PreclearedError,
  ValidationError,
  AuthError,
  PaymentRequiredError,
  RateLimitError,
  ReceiptNotFoundError,
  ServerError,
  NetworkError,
  isPreclearedError,
} from "./errors";
export type { PreclearedErrorOptions, RateLimitKind, ValidationIssue } from "./errors";

export { ADDRESS_SOURCES, CONFIDENCES, DEFAULT_BASE_URL, VERDICTS } from "./types";
export type {
  AddressSource,
  CheckFacts,
  CheckInput,
  CheckResult,
  Confidence,
  Health,
  Reason,
  Receipt,
  Usage,
  Verdict,
} from "./types";

export {
  decidingReason,
  decidingRule,
  describeReason,
  isOk,
  mustNotSend,
  needsMoreFacts,
  normaliseCheckResult,
  normaliseReceipt,
  normaliseReceiptId,
  notes,
  receiptFromPayload,
  receiptSummary,
  receiptSummaryText,
  receiptUrl,
  summary,
  summaryText,
} from "./result";
export type { CheckSummary, ReceiptSummary } from "./result";

export { createToolHandlers, checkInputFromArgs, coerceBool, errorPayload, formatError } from "./tools";
export type {
  CheckToolOutput,
  ContactCheckArgs,
  ToolErrorPayload,
  ToolFormat,
  ToolHandlers,
  ToolOptions,
  VerifyReceiptArgs,
  VerifyToolOutput,
} from "./tools";

export { ARG_DESCRIPTIONS, CHECK_DESCRIPTION, CHECK_TOOL_NAME, VERIFY_DESCRIPTION, VERIFY_TOOL_NAME } from "./descriptions";

export { MissingDependencyError } from "./peer";
