/**
 * Turning API JSON into typed results, and small helpers for reading them:
 * `isOk`, `mustNotSend`, `receiptUrl`, `summary`, `summaryText` and friends.
 * The summaries are what the framework tools return to the model.
 */

import { ValidationError } from "./errors";
import type { CheckResult, Health, Reason, Receipt, Usage } from "./types";
import { DEFAULT_BASE_URL } from "./types";

type Dict = Record<string, unknown>;

export function isRecord(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : String(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function optInt(value: unknown): number | null {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : null;
}

function optBool(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  return Boolean(value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

// ---------------------------------------------------------------------------
// Normalising responses
// ---------------------------------------------------------------------------

export function normaliseReason(value: unknown): Reason {
  if (typeof value === "string") return { note: value };
  if (!isRecord(value)) return {};
  return {
    ...value,
    rule_key: optString(value.rule_key),
    text: optString(value.text),
    source_title: optString(value.source_title),
    source_url: optString(value.source_url),
    note: optString(value.note),
  };
}

export function normaliseUsage(value: unknown): Usage | null {
  if (!isRecord(value)) return null;
  return {
    ...value,
    free_remaining_today: optInt(value.free_remaining_today),
    credits_remaining: optInt(value.credits_remaining),
    low_balance: optBool(value.low_balance),
    top_up_url: optString(value.top_up_url),
    notice: optString(value.notice),
  };
}

/** Build a `Receipt` from a JSON object. Accepts `id` or `receipt_id`. */
export function normaliseReceipt(data: unknown): Receipt {
  if (!isRecord(data)) {
    throw new ValidationError("receipt must be a JSON object", { code: "invalid_response" });
  }
  const id = nonEmptyString(data.id) ?? nonEmptyString(data.receipt_id);
  if (!id) throw new ValidationError("receipt has no id", { code: "invalid_response" });
  const receipt: Receipt = { ...data, id };
  for (const key of [
    "created_at",
    "request_hash",
    "response_hash",
    "signature",
    "algorithm",
    "key_version",
    "verify_url",
    "public_key",
    "verdict",
    "confidence",
    "recipient_domain",
    "recipient_email_masked",
    "sender_country",
    "rules_version",
  ] as const) {
    if (key in data) (receipt as Dict)[key] = optString(data[key]);
  }
  if ("rules_applied" in data) receipt.rules_applied = stringList(data.rules_applied);
  return receipt;
}

/** The receipt endpoint's JSON, flat or wrapped in `{ receipt: {...}, public_key }`. */
export function receiptFromPayload(data: Dict): Receipt {
  const inner = data.receipt;
  if (isRecord(inner) && (nonEmptyString(inner.id) || nonEmptyString(inner.receipt_id))) {
    const merged: Dict = { ...inner };
    for (const key of ["public_key", "key_version", "algorithm", "verify_url"]) {
      if (!(key in merged) && key in data) merged[key] = data[key];
    }
    return normaliseReceipt(merged);
  }
  return normaliseReceipt(data);
}

/** Build a `CheckResult` from the JSON of `POST /api/v1/check`. */
export function normaliseCheckResult(data: Dict): CheckResult {
  const verdict = nonEmptyString(data.verdict);
  if (!verdict) throw new ValidationError("check response has no verdict", { code: "invalid_response" });

  const receiptRaw = data.receipt;
  const receipt =
    isRecord(receiptRaw) && (nonEmptyString(receiptRaw.id) || nonEmptyString(receiptRaw.receipt_id))
      ? normaliseReceipt(receiptRaw)
      : null;

  return {
    ...data,
    verdict: verdict as CheckResult["verdict"],
    confidence: optString(data.confidence) as CheckResult["confidence"],
    reasons: Array.isArray(data.reasons) ? data.reasons.map(normaliseReason) : [],
    rules_applied: stringList(data.rules_applied),
    footer_text: optString(data.footer_text),
    next_step: optString(data.next_step),
    facts: isRecord(data.facts) ? { ...data.facts } : {},
    receipt,
    usage: normaliseUsage(data.usage),
    disclaimer: optString(data.disclaimer),
    rules_version: optString(data.rules_version),
  };
}

export function normaliseHealth(data: Dict): Health {
  return {
    ...data,
    status: nonEmptyString(data.status) ?? "unknown",
    checked_at: optString(data.checked_at),
    api_ok: optBool(data.api_ok),
    mcp_ok: optBool(data.mcp_ok),
    worker_ok: optBool(data.worker_ok),
  };
}

// ---------------------------------------------------------------------------
// Receipt ids and URLs
// ---------------------------------------------------------------------------

const RECEIPT_ID = /cc_rcpt_[0-9A-Za-z]+/;

/** Accept a bare id or a receipt URL and return the `cc_rcpt_...` id. */
export function normaliseReceiptId(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError("receipt id is required, for example 'cc_rcpt_...'", { code: "invalid_arguments" });
  }
  const trimmed = value.trim();
  const match = RECEIPT_ID.exec(trimmed);
  if (match) return match[0];
  if (/[/?= ]/.test(trimmed)) {
    throw new ValidationError(`not a receipt id: ${JSON.stringify(value)}`, { code: "invalid_arguments" });
  }
  return trimmed;
}

/**
 * The human-readable receipt page, `https://precleared.dev/r/<id>`. Takes a
 * receipt id, a `Receipt` or a `CheckResult`; returns null when there is no
 * receipt.
 */
export function receiptUrl(
  target: string | Receipt | CheckResult | null | undefined,
  baseUrl: string = DEFAULT_BASE_URL,
): string | null {
  let id: string | null = null;
  if (typeof target === "string") {
    id = target;
  } else if (isRecord(target)) {
    if (typeof target.id === "string") {
      id = target.id; // a Receipt
    } else if (isRecord(target.receipt) && typeof target.receipt.id === "string") {
      id = target.receipt.id; // a CheckResult
    }
  }
  if (!id) return null;
  return `${baseUrl.replace(/\/+$/, "")}/r/${id}`;
}

// ---------------------------------------------------------------------------
// Reading a result
// ---------------------------------------------------------------------------

/** True when the verdict is `ok_to_email`. */
export function isOk(result: Pick<CheckResult, "verdict">): boolean {
  return result.verdict === "ok_to_email";
}

/**
 * True for `consent_needed` and `blocked`. `unknown` is not included on
 * purpose: it means a fact could not be established. Treat it as
 * `consent_needed` unless you can supply the missing fact and check again.
 */
export function mustNotSend(result: Pick<CheckResult, "verdict">): boolean {
  return result.verdict === "consent_needed" || result.verdict === "blocked";
}

/** True when the verdict is `unknown`. */
export function needsMoreFacts(result: Pick<CheckResult, "verdict">): boolean {
  return result.verdict === "unknown";
}

/** The reason that carries the rule that decided the verdict, if any. */
export function decidingReason(result: Pick<CheckResult, "reasons">): Reason | null {
  return result.reasons.find((reason) => Boolean(reason.rule_key)) ?? null;
}

/** `rule_key` of the reason that decided the verdict, if any. */
export function decidingRule(result: Pick<CheckResult, "reasons">): string | null {
  return decidingReason(result)?.rule_key ?? null;
}

/** Notes from the reasons list: every entry that is not the rule. */
export function notes(result: Pick<CheckResult, "reasons">): string[] {
  const out: string[] = [];
  for (const reason of result.reasons) {
    if (reason.rule_key) continue;
    const text = reason.note || reason.text;
    if (text) out.push(text);
  }
  return out;
}

/** One line of plain text for a reason, with its source. */
export function describeReason(reason: Reason): string {
  const parts: string[] = [];
  if (reason.text) parts.push(reason.text);
  else if (reason.note) parts.push(reason.note);
  if (reason.source_title && reason.source_url) parts.push(`Source: ${reason.source_title}, ${reason.source_url}`);
  else if (reason.source_url) parts.push(`Source: ${reason.source_url}`);
  else if (reason.source_title) parts.push(`Source: ${reason.source_title}`);
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Summaries (what the framework tools return)
// ---------------------------------------------------------------------------

export interface CheckSummary {
  verdict: string;
  confidence: string | null;
  rule: string | null;
  reason: string | null;
  source_title: string | null;
  source_url: string | null;
  notes: string[];
  footer_text: string | null;
  next_step: string | null;
  receipt_id: string | null;
  receipt_url: string | null;
  free_remaining_today?: number | null;
  credits_remaining?: number | null;
  disclaimer?: string;
}

/** Compact object with what a sending agent needs to decide. */
export function summary(result: CheckResult, baseUrl: string = DEFAULT_BASE_URL): CheckSummary {
  const reason = decidingReason(result);
  const out: CheckSummary = {
    verdict: result.verdict,
    confidence: result.confidence ?? null,
    rule: reason?.rule_key ?? null,
    reason: reason ? (reason.text || reason.note || null) : null,
    source_title: reason?.source_title ?? null,
    source_url: reason?.source_url ?? null,
    notes: notes(result),
    footer_text: result.footer_text ?? null,
    next_step: result.next_step ?? null,
    receipt_id: result.receipt?.id ?? null,
    receipt_url: receiptUrl(result, baseUrl),
  };
  if (result.usage) {
    out.free_remaining_today = result.usage.free_remaining_today ?? null;
    out.credits_remaining = result.usage.credits_remaining ?? null;
  }
  if (result.disclaimer) out.disclaimer = result.disclaimer;
  return out;
}

/** Compact text for a model: verdict, rule, footer_text, next_step, receipt. */
export function summaryText(result: CheckResult, baseUrl: string = DEFAULT_BASE_URL): string {
  const lines = [`verdict: ${result.verdict}` + (result.confidence ? ` (confidence: ${result.confidence})` : "")];
  const reason = decidingReason(result);
  if (reason?.rule_key) lines.push(`rule: ${reason.rule_key}`);
  if (reason) {
    const described = describeReason(reason);
    if (described) lines.push(`reason: ${described}`);
  }
  for (const note of notes(result)) lines.push(`note: ${note}`);
  if (result.footer_text) lines.push(`footer_text: ${result.footer_text}`);
  if (result.next_step) lines.push(`next_step: ${result.next_step}`);
  if (result.receipt) lines.push(`receipt: ${result.receipt.id} ${receiptUrl(result, baseUrl)}`);
  return lines.join("\n");
}

const RECEIPT_SUMMARY_FIELDS = [
  "created_at",
  "verdict",
  "confidence",
  "rules_applied",
  "recipient_email_masked",
  "recipient_domain",
  "sender_country",
  "rules_version",
  "request_hash",
  "response_hash",
  "signature",
  "algorithm",
  "key_version",
  "verify_url",
] as const;

export interface ReceiptSummary {
  receipt_id: string;
  receipt_url?: string;
  created_at?: string;
  verdict?: string;
  confidence?: string;
  rules_applied?: string[];
  recipient_email_masked?: string;
  recipient_domain?: string;
  sender_country?: string;
  rules_version?: string;
  request_hash?: string;
  response_hash?: string;
  signature?: string;
  algorithm?: string;
  key_version?: string;
  verify_url?: string;
}

/** Compact object for structured tool output (no public key). */
export function receiptSummary(receipt: Receipt): ReceiptSummary {
  const out: Record<string, unknown> = { receipt_id: receipt.id };
  for (const name of RECEIPT_SUMMARY_FIELDS) {
    const value = receipt[name];
    if (value === null || value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[name] = value;
  }
  return out as unknown as ReceiptSummary;
}

/** Compact text for a model: one `name: value` line per known field. */
export function receiptSummaryText(receipt: Receipt): string {
  const lines = [`receipt: ${receipt.id}`];
  for (const [name, value] of Object.entries(receiptSummary(receipt))) {
    if (name === "receipt_id") continue;
    lines.push(`${name}: ${Array.isArray(value) ? value.join(", ") : String(value)}`);
  }
  return lines.join("\n");
}
