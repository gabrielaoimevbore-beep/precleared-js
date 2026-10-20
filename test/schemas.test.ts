import { describe, expect, it } from "vitest";

import {
  ARG_DESCRIPTIONS,
  CHECK_DESCRIPTION,
  CHECK_TOOL_NAME,
  VERIFY_DESCRIPTION,
  VERIFY_TOOL_NAME,
  checkInputSchema,
  contactCheckInputSchema,
  jsonSchema,
  verifyReceiptInputSchema,
} from "../src/schemas";
import { ADDRESS_SOURCES } from "../src/types";

const CHECK_FIELDS = [
  "recipient_email",
  "recipient_domain",
  "pitch",
  "address_source",
  "existing_customer",
  "pitch_relevant",
  "sender_country",
  "recipient_country",
  "company_number",
  "suppressed",
];

describe("checkInputSchema (client validation)", () => {
  it("accepts a full, normalised input", () => {
    const parsed = checkInputSchema.safeParse({
      recipient_email: "jane@acme.co.uk",
      pitch: "Bookkeeping",
      address_source: "bought",
      sender_country: "GB",
      existing_customer: false,
      pitch_relevant: true,
      company_number: "01234567",
      recipient_country: "GB",
      default_recipient_country: "IE",
      suppressed: false,
    });
    expect(parsed.success).toBe(true);
  });

  it("requires a recipient", () => {
    const parsed = checkInputSchema.safeParse({ pitch: "x" });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe("recipient_email or recipient_domain is required");
  });

  it("rejects an unknown address_source with a plain message", () => {
    const parsed = checkInputSchema.safeParse({ recipient_email: "a@b.co", address_source: "guessed" });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe("address_source must be one of published, bought, scraped, given, unknown");
    expect(parsed.error?.issues[0]?.path).toEqual(["address_source"]);
  });

  it.each(["sender_country", "recipient_country", "default_recipient_country"])("checks %s is two upper-case letters", (field) => {
    expect(checkInputSchema.safeParse({ recipient_email: "a@b.co", [field]: "GB" }).success).toBe(true);
    for (const bad of ["gb", "GBR", "", 44]) {
      const parsed = checkInputSchema.safeParse({ recipient_email: "a@b.co", [field]: bad });
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.message).toBe(`${field} must be a two-letter country code such as 'GB'`);
    }
  });

  it.each(["existing_customer", "pitch_relevant", "suppressed"])("checks %s is a boolean", (field) => {
    const parsed = checkInputSchema.safeParse({ recipient_email: "a@b.co", [field]: "yes" });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe(`${field} must be true or false`);
  });

  it("rejects non-string text fields", () => {
    const parsed = checkInputSchema.safeParse({ recipient_email: 42 });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe("recipient_email must be a string");
  });
});

describe("tool schemas (what the model sees)", () => {
  it("contactCheckInputSchema has the Python SDK's fields, defaults and descriptions", () => {
    expect(Object.keys(contactCheckInputSchema.shape).sort()).toEqual([...CHECK_FIELDS].sort());
    const parsed = contactCheckInputSchema.parse({ recipient_email: "jane@acme.co.uk" });
    expect(parsed.address_source).toBe("unknown");
    expect(parsed.existing_customer).toBe(false);
    expect(parsed.sender_country).toBe("GB");
    expect(parsed.pitch_relevant).toBeUndefined();
    expect(contactCheckInputSchema.safeParse({ address_source: "guessed" }).success).toBe(false);
    expect(contactCheckInputSchema.safeParse({ existing_customer: "true" }).success).toBe(false);
    expect(contactCheckInputSchema.shape.address_source.description).toBe(ARG_DESCRIPTIONS.address_source);
    expect(contactCheckInputSchema.shape.recipient_email.description).toBe(ARG_DESCRIPTIONS.recipient_email);
  });

  it("verifyReceiptInputSchema requires receipt_id", () => {
    expect(verifyReceiptInputSchema.safeParse({}).success).toBe(false);
    expect(verifyReceiptInputSchema.parse({ receipt_id: "cc_rcpt_X" })).toEqual({ receipt_id: "cc_rcpt_X" });
    expect(verifyReceiptInputSchema.shape.receipt_id.description).toBe(ARG_DESCRIPTIONS.receipt_id);
  });
});

describe("jsonSchema()", () => {
  it("mirrors the zod schemas as plain JSON Schema", () => {
    const schema = jsonSchema();
    expect(schema.contact_check.name).toBe("contact_check");
    expect(schema.contact_check.description).toBe(CHECK_DESCRIPTION);
    expect(schema.verify_receipt.name).toBe("verify_receipt");
    expect(schema.verify_receipt.description).toBe(VERIFY_DESCRIPTION);

    const check = schema.contact_check.parameters;
    expect(check.type).toBe("object");
    expect(check.additionalProperties).toBe(false);
    expect(Object.keys(check.properties).sort()).toEqual(Object.keys(contactCheckInputSchema.shape).sort());
    expect(check.properties.address_source).toEqual({
      type: "string",
      enum: [...ADDRESS_SOURCES],
      default: "unknown",
      description: ARG_DESCRIPTIONS.address_source,
    });
    expect(check.properties.existing_customer).toEqual({ type: "boolean", default: false, description: ARG_DESCRIPTIONS.existing_customer });
    expect(check.properties.sender_country?.default).toBe("GB");
    expect(check.required).toBeUndefined();
    for (const [name, property] of Object.entries(check.properties)) {
      expect(property.description).toBe(ARG_DESCRIPTIONS[name as keyof typeof ARG_DESCRIPTIONS]);
    }

    const verify = schema.verify_receipt.parameters;
    expect(verify.required).toEqual(["receipt_id"]);
    expect(verify.properties.receipt_id).toEqual({ type: "string", description: ARG_DESCRIPTIONS.receipt_id });
  });

  it("returns fresh copies", () => {
    const first = jsonSchema();
    first.contact_check.parameters.properties.pitch!.description = "changed";
    expect(jsonSchema().contact_check.parameters.properties.pitch?.description).toBe(ARG_DESCRIPTIONS.pitch);
    expect(JSON.parse(JSON.stringify(jsonSchema()))).toEqual(jsonSchema());
  });
});

describe("descriptions", () => {
  it("tell the model when to call the tools, in the Python SDK's words", () => {
    expect(CHECK_TOOL_NAME).toBe("contact_check");
    expect(VERIFY_TOOL_NAME).toBe("verify_receipt");
    for (const phrase of [
      "before the first cold email",
      "not already a customer",
      "UK, US, Canada, Germany, France, Australia, Ireland or the Netherlands",
      "Not needed for transactional email",
      "ok_to_email means send, with a footer that meets footer_text",
      "consent_needed and blocked mean do not send",
      "unknown means a fact could not be established: treat it as consent_needed unless you can supply the missing fact",
      "Decision support with sources, not legal advice",
    ]) {
      expect(CHECK_DESCRIPTION).toContain(phrase);
    }
    expect(VERIFY_DESCRIPTION).toContain("cc_rcpt_");
    expect(VERIFY_DESCRIPTION).toContain("Does not run a new check");
    expect(CHECK_DESCRIPTION.length).toBeLessThanOrEqual(1024);
    expect(VERIFY_DESCRIPTION.length).toBeLessThanOrEqual(1024);
    expect(ARG_DESCRIPTIONS.address_source).toContain("Never guess published");
    const everything = CHECK_DESCRIPTION + VERIFY_DESCRIPTION + Object.values(ARG_DESCRIPTIONS).join(" ");
    expect(everything).not.toContain("—");
  });
});
