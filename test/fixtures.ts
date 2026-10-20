/**
 * Response fixtures. OK_PAYLOAD, UNKNOWN_PAYLOAD and RECEIPT_PAYLOAD are the
 * live examples from the RapidAPI listing (captured 2026-10-17); CONSENT_PAYLOAD
 * and CONSENT_RECEIPT are the live sample the Python SDK's tests replay. They
 * pin the real field names, so a parser change that breaks on genuine output
 * fails here without any network access.
 */

export const OK_PAYLOAD = {
  verdict: "ok_to_email",
  confidence: "high",
  reasons: [
    {
      rule_key: "us_canspam_ok",
      text:
        "US law does not require prior consent for commercial email, including business to business. CAN-SPAM governs the content and the opt-out: truthful headers and subject line, identified as an advertisement, a valid physical postal address, a working opt-out honoured within 10 business days, and no exception for business-to-business email.",
      source_title: "FTC CAN-SPAM Act compliance guide for business",
      source_url: "https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business",
    },
  ],
  rules_applied: ["us_canspam_ok"],
  footer_text:
    "Truthful From and subject line; make clear it is a commercial message; include your valid physical postal address; give a clear opt-out that works for at least 30 days and honour it within 10 business days. California and Washington add their own rules against misleading subject lines and headers.",
  next_step: "Send. Log the receipt against the lead. Keep the opt-out working.",
  facts: {
    recipient_email_masked: "s***@precleared.dev",
    recipient_domain: "precleared.dev",
    recipient_country: "US",
    country_source: "caller",
    legal_form: "unknown",
    legal_form_source: "none",
    company_number: null,
    company_name: null,
    company_status: null,
    director_first_name: null,
    address_type: "role",
    syntax_ok: true,
    mx_ok: true,
    disposable: false,
    suppressed: false,
  },
  receipt: {
    id: "cc_rcpt_363BBFMQ3YNSKA6A",
    created_at: "2026-10-17T02:31:44.217Z",
    request_hash: "626f88ee13bf08b4b2a891796540f237b6b6c553d136662ca408b59ecea87cbc",
    response_hash: "6f9d176b95e310e47feda13e4d2bc6684e50ee3c6b1beee01b962ddcfac97b90",
    signature: "0z7HqebPWSb3hB5fapr7yMFJ/jWFzxVHlB4kjuqm5/FiRUvMVXqruJc6W4GPX23woKGjMgacG7rEkGJ4Wmg8Dg==",
    algorithm: "ed25519",
    key_version: "k1",
    verify_url: "https://precleared.dev/api/v1/receipt?id=cc_rcpt_363BBFMQ3YNSKA6A",
  },
  rules_version: "v1-draft",
  usage: { free_remaining_today: 24, credits_remaining: 0 },
  disclaimer:
    "Decision support with sources, not legal advice. The receipt proves what was asked and answered, not that an email was sent.",
};

export const UNKNOWN_PAYLOAD = {
  verdict: "unknown",
  confidence: "low",
  reasons: [
    {
      rule_key: "any_no_mx",
      text:
        "The domain has no mail server record, so the address probably cannot receive email. The legal position was not assessed because the message would not arrive.",
      source_title: "DNS MX lookup (internal check)",
      source_url: "https://www.rfc-editor.org/rfc/rfc5321",
    },
  ],
  rules_applied: ["any_no_mx"],
  footer_text: null,
  next_step: "Check the domain is spelt correctly. If it is, drop the lead.",
  facts: {
    recipient_email_masked: "h***@example.com",
    recipient_domain: "example.com",
    recipient_country: "US",
    country_source: "caller",
    legal_form: "unknown",
    legal_form_source: "none",
    company_number: null,
    company_name: null,
    company_status: null,
    director_first_name: null,
    address_type: "role",
    syntax_ok: true,
    mx_ok: false,
    disposable: false,
    suppressed: false,
  },
  receipt: {
    id: "cc_rcpt_4M460J4JCZVFQQTZ",
    created_at: "2026-10-17T02:31:29.868Z",
    request_hash: "612be0a6c5429873dccc1afe65c7441f78496edfdb42e2fbab799729f13be625",
    response_hash: "249ab9539a6dae0d30d8c5300487f395b5896173e4b8199c88576923314e0087",
    signature: "AG6Bv9yzf8tCg4W3KyY0VBLlLoopbmPRkOM8gbAKnWT+punwAhf/lAFG4gCkmKNWw1KZQFIZrnhxfbuGlepiBw==",
    algorithm: "ed25519",
    key_version: "k1",
    verify_url: "https://precleared.dev/api/v1/receipt?id=cc_rcpt_4M460J4JCZVFQQTZ",
  },
  rules_version: "v1-draft",
  usage: { free_remaining_today: 24, credits_remaining: 0 },
  disclaimer:
    "Decision support with sources, not legal advice. The receipt proves what was asked and answered, not that an email was sent.",
};

/** GET /api/v1/receipt for the unknown check above: flat, with the public key and no verify_url. */
export const RECEIPT_PAYLOAD = {
  id: "cc_rcpt_4M460J4JCZVFQQTZ",
  created_at: "2026-10-17T02:31:29.868+00:00",
  verdict: "unknown",
  confidence: "low",
  rules_applied: ["any_no_mx"],
  recipient_domain: "example.com",
  recipient_email_masked: "h***@example.com",
  sender_country: "GB",
  rules_version: "v1-draft",
  request_hash: "612be0a6c5429873dccc1afe65c7441f78496edfdb42e2fbab799729f13be625",
  response_hash: "249ab9539a6dae0d30d8c5300487f395b5896173e4b8199c88576923314e0087",
  signature: "AG6Bv9yzf8tCg4W3KyY0VBLlLoopbmPRkOM8gbAKnWT+punwAhf/lAFG4gCkmKNWw1KZQFIZrnhxfbuGlepiBw==",
  algorithm: "ed25519",
  key_version: "k1",
  public_key: "MCowBQYDK2VwAyEAxKYMJSUl95O2MxJPAHNR5HeGD8DFEoNZLP7UZ3cafMM=",
};

/** A UK sole trader: the verdict most people meet first. Includes a note entry. */
export const CONSENT_PAYLOAD = {
  verdict: "consent_needed",
  confidence: "medium",
  reasons: [
    {
      rule_key: "gb_individual_consent",
      text:
        "The recipient is a sole trader or a partnership in England, Wales or Northern Ireland. PECR treats them as individual subscribers, so unsolicited marketing email needs their prior consent, or the soft opt-in for existing customers.",
      source_title: "PECR 2003 regulation 22(2) and ICO Guide to PECR",
      source_url: "https://www.legislation.gov.uk/uksi/2003/2426/regulation/22",
    },
    { note: "Legal form came from the company website." },
  ],
  rules_applied: ["gb_individual_consent"],
  footer_text: null,
  next_step: "Do not cold email. Use a route they offer, such as their contact form, or obtain consent first.",
  facts: {
    recipient_email_masked: "s***@precleared.dev",
    recipient_domain: "precleared.dev",
    recipient_country: "GB",
    country_source: "caller",
    legal_form: "individual",
    legal_form_source: "website",
    company_number: null,
    company_name: null,
    company_status: null,
    director_first_name: null,
    address_type: "role",
    syntax_ok: true,
    mx_ok: true,
    disposable: false,
    suppressed: false,
  },
  receipt: {
    id: "cc_rcpt_E21TTJV8D9JAYTQZ",
    created_at: "2026-10-17T10:15:22.590Z",
    request_hash: "36830a6f0c0d441cc0672e02f6ab02c8e6fedaf6e42e7e67c06750afd0363fb5",
    response_hash: "0c07fee9789c58fe165b693e45c0a2114a4082b3a9f6c04cb1cca636972633bd",
    signature: "gPAeSzHg2wRuSsMd0Iy28UM1eojy5IoAND7A/GfuV29e9GjeQmTJgOlVQzwH9qRNKtyvKJ/3UWW9e6Xee33QCA==",
    algorithm: "ed25519",
    key_version: "k1",
    verify_url: "https://precleared.dev/api/v1/receipt?id=cc_rcpt_E21TTJV8D9JAYTQZ",
  },
  rules_version: "v1-draft",
  usage: { free_remaining_today: 99, credits_remaining: 0 },
  disclaimer:
    "Decision support with sources, not legal advice. The receipt proves what was asked and answered, not that an email was sent.",
};

export const CONSENT_RECEIPT = {
  id: "cc_rcpt_E21TTJV8D9JAYTQZ",
  created_at: "2026-10-17T10:15:22.59+00:00",
  verdict: "consent_needed",
  confidence: "medium",
  rules_applied: ["gb_individual_consent"],
  recipient_domain: "precleared.dev",
  recipient_email_masked: "s***@precleared.dev",
  sender_country: "GB",
  rules_version: "v1-draft",
  request_hash: "36830a6f0c0d441cc0672e02f6ab02c8e6fedaf6e42e7e67c06750afd0363fb5",
  response_hash: "0c07fee9789c58fe165b693e45c0a2114a4082b3a9f6c04cb1cca636972633bd",
  signature: "gPAeSzHg2wRuSsMd0Iy28UM1eojy5IoAND7A/GfuV29e9GjeQmTJgOlVQzwH9qRNKtyvKJ/3UWW9e6Xee33QCA==",
  algorithm: "ed25519",
  key_version: "k1",
  public_key: "MCowBQYDK2VwAyEAxKYMJSUl95O2MxJPAHNR5HeGD8DFEoNZLP7UZ3cafMM=",
};

export const HEALTH_PAYLOAD = {
  status: "ok",
  checked_at: "2026-10-17T02:30:02.442963+00:00",
  api_ok: true,
  mcp_ok: true,
  worker_ok: true,
};

export const KEY = "pc_live_0123456789abcdef0123456789abcdef";
