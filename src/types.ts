/**
 * Types for the Precleared API: the fields `check()` takes and the JSON it
 * returns. Field names match the API, so what you read in a response is what
 * you see at https://precleared.dev/docs.
 */

export const DEFAULT_BASE_URL = "https://precleared.dev";

export const VERDICTS = ["ok_to_email", "consent_needed", "blocked", "unknown"] as const;
export const ADDRESS_SOURCES = ["published", "bought", "scraped", "given", "unknown"] as const;
export const CONFIDENCES = ["high", "medium", "low"] as const;

export type Verdict = (typeof VERDICTS)[number];
export type AddressSource = (typeof ADDRESS_SOURCES)[number];
export type Confidence = (typeof CONFIDENCES)[number];

/**
 * Input for `client.check()`. One of `recipient_email` or `recipient_domain`
 * is required. `address_source` defaults to `"unknown"` and is always sent.
 *
 * Unknown fields are forwarded to the API as they are, for request fields
 * newer than this client. `null` and `undefined` values are left out.
 */
export interface CheckInput {
  /** The address you want to email. Give this or `recipient_domain`. */
  recipient_email?: string | null;
  /** The recipient's domain when you have no address yet, for example `acme.co.uk`. */
  recipient_domain?: string | null;
  /** What you are offering, in one sentence. */
  pitch?: string | null;
  /**
   * How you got the address: `published`, `bought`, `scraped`, `given` or
   * `unknown`. Defaults to `unknown`. Only say `published` when the recipient
   * put the address on their own website or a public listing for people to
   * contact them.
   */
  address_source?: AddressSource | null;
  /** Two-letter code for where you send from. Default `GB`. */
  sender_country?: string | null;
  /** True if the recipient has bought from you. Default false. */
  existing_customer?: boolean | null;
  /** Whether the pitch relates to the recipient's role. */
  pitch_relevant?: boolean | null;
  /** UK Companies House number, when you know it. */
  company_number?: string | number | null;
  /** Two-letter code. Overrides what Precleared infers. */
  recipient_country?: string | null;
  /** Used only when the country cannot be worked out from the address, register or website. */
  default_recipient_country?: string | null;
  /** True if the address is on your own suppression list. */
  suppressed?: boolean | null;
}

/**
 * One entry in `CheckResult.reasons`: either the rule that decided the verdict
 * (`rule_key`, `text` and a source) or a note about the facts (`note`).
 */
export interface Reason {
  rule_key?: string | null;
  text?: string | null;
  source_title?: string | null;
  source_url?: string | null;
  note?: string | null;
  [key: string]: unknown;
}

/** What Precleared established about the address and the company. */
export interface CheckFacts {
  recipient_email_masked?: string | null;
  recipient_domain?: string | null;
  recipient_country?: string | null;
  country_source?: string | null;
  legal_form?: string | null;
  legal_form_source?: string | null;
  company_number?: string | null;
  company_name?: string | null;
  company_status?: string | null;
  director_first_name?: string | null;
  address_type?: string | null;
  syntax_ok?: boolean | null;
  mx_ok?: boolean | null;
  disposable?: boolean | null;
  suppressed?: boolean | null;
  [key: string]: unknown;
}

/**
 * A signed record that a check happened and what it said.
 *
 * Returned inside every check response and by `getReceipt()`. The receipt
 * endpoint also returns the verdict the check gave, the masked address and
 * the Ed25519 public key; those fields are absent on the receipt embedded in
 * a check response. The signature is Ed25519 over `request_hash.response_hash`.
 */
export interface Receipt {
  id: string;
  created_at?: string | null;
  request_hash?: string | null;
  response_hash?: string | null;
  signature?: string | null;
  algorithm?: string | null;
  key_version?: string | null;
  verify_url?: string | null;
  public_key?: string | null;
  verdict?: Verdict | null;
  confidence?: Confidence | null;
  rules_applied?: string[];
  recipient_domain?: string | null;
  recipient_email_masked?: string | null;
  sender_country?: string | null;
  rules_version?: string | null;
  [key: string]: unknown;
}

/** Allowance information returned with every check. */
export interface Usage {
  free_remaining_today?: number | null;
  credits_remaining?: number | null;
  low_balance?: boolean | null;
  top_up_url?: string | null;
  notice?: string | null;
  [key: string]: unknown;
}

/** The answer to one check: the body of `POST /api/v1/check`. */
export interface CheckResult {
  /** `ok_to_email`, `consent_needed`, `blocked` or `unknown`. */
  verdict: Verdict;
  /** `high`, `medium` or `low`. */
  confidence: Confidence | null;
  /** The rule that decided the verdict, with its source, plus notes. */
  reasons: Reason[];
  /** Rule keys used, in order. */
  rules_applied: string[];
  /** What the email footer must include. A requirement to meet, not wording to paste. */
  footer_text: string | null;
  /** One line on what to do next. */
  next_step: string | null;
  /** What Precleared established about the address and company. */
  facts: CheckFacts;
  /** Signed receipt for this check. */
  receipt: Receipt | null;
  /** Remaining free checks and pack credits. */
  usage: Usage | null;
  /** Fixed line: decision support with sources, not legal advice. */
  disclaimer: string | null;
  /** Version of the rule set used. */
  rules_version: string | null;
  [key: string]: unknown;
}

/** Result of `GET /api/v1/health`: the latest five-minute pulse. */
export interface Health {
  status: string;
  checked_at?: string | null;
  api_ok?: boolean | null;
  mcp_ok?: boolean | null;
  worker_ok?: boolean | null;
  [key: string]: unknown;
}
