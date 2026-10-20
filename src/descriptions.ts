/**
 * Tool names, descriptions and argument descriptions shared by the Vercel AI
 * SDK, Mastra and LangChain helpers and by `jsonSchema()`. The wording is the
 * same as the Python SDK's tools, so an agent behaves the same whichever
 * language it runs in.
 *
 * This module has no dependencies, not even zod.
 */

export const CHECK_TOOL_NAME = "contact_check";
export const VERIFY_TOOL_NAME = "verify_receipt";

// Kept under 1024 characters: the OpenAI limit for a function description.
export const CHECK_DESCRIPTION =
  "Check whether a cold or marketing email to one recipient is legal. " +
  "Call this once per address before the first cold email to anyone who is not already a customer, " +
  "in the UK, US, Canada, Germany, France, Australia, Ireland or the Netherlands, including every " +
  "address in a lead list. Not needed for transactional email such as invoices or password resets. " +
  "It applies the local rules (UK PECR, US CAN-SPAM, Canadian CASL and others) using live lookups " +
  "such as UK Companies House. Returns a verdict, the rule that decided it with its source, " +
  "footer_text, next_step and a signed receipt id. ok_to_email means send, with a footer that meets " +
  "footer_text (a requirement, not wording to paste). consent_needed and blocked mean do not send; " +
  "follow next_step. unknown means a fact could not be established: treat it as consent_needed unless " +
  "you can supply the missing fact (such as recipient_country or company_number) and check again. " +
  "Nothing is sent to the recipient. Decision support with sources, not legal advice.";

export const VERIFY_DESCRIPTION =
  "Fetch a Precleared receipt by its id (cc_rcpt_...) to show that a cold-email check happened and what " +
  "it said. Use it when a client, auditor or regulator asks for evidence of a check, or to re-read a past " +
  "verdict without spending another check. Returns the receipt id, time, request and response hashes, " +
  "Ed25519 signature and verification URL. Does not run a new check and sends nothing to anyone.";

export const ARG_DESCRIPTIONS = {
  recipient_email: "The address you want to email. Give this or recipient_domain.",
  recipient_domain: "The recipient's domain when you have no address yet, for example acme.co.uk.",
  pitch: "What you are offering, in one sentence.",
  address_source:
    "How the address was obtained: published (the recipient put it on their own website or a public " +
    "listing so people can contact them), bought (from a data vendor or list), scraped (collected from " +
    "the web by a tool), given (the recipient gave it to you directly) or unknown. " +
    "Use unknown when you are not sure. Never guess published.",
  existing_customer: "True only if the recipient has bought from the sender before.",
  pitch_relevant:
    "True if the pitch relates to the recipient's role or business, false if it does not. " +
    "Leave unset when unsure.",
  sender_country: "Two-letter code for where the sender is based, for example GB or US. Default GB.",
  recipient_country:
    "Two-letter country code for the recipient when you know it. Otherwise Precleared works it out " +
    "from the domain, the register and the website.",
  company_number:
    "UK Companies House number when known. Raises confidence for UK recipients and can resolve an " +
    "unknown verdict.",
  suppressed: "True if the address is on the sender's own suppression or unsubscribe list.",
  receipt_id: "Receipt id from a previous check, starting cc_rcpt_. A receipt URL also works.",
} as const;
