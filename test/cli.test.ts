import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EXIT_ERROR, EXIT_HOLD, EXIT_OK, HELP, findEmail, main, parseAddressList, type CliIO } from "../src/cli";
import { VERSION } from "../src/version";

import { CONSENT_PAYLOAD, KEY, OK_PAYLOAD, UNKNOWN_PAYLOAD } from "./fixtures";
import { MockFetch, jsonResponse, rawResponse, type Handler, type RecordedRequest } from "./helpers";

const BLOCKED_PAYLOAD = {
  ...CONSENT_PAYLOAD,
  verdict: "blocked",
  reasons: [{ rule_key: "any_suppressed", text: "The address is on your suppression list." }],
  rules_applied: ["any_suppressed"],
  next_step: "Do not email. Leave the address on the suppression list.",
  receipt: { ...CONSENT_PAYLOAD.receipt, id: "cc_rcpt_BLOCKED000000001" },
};

const posix = process.platform !== "win32";

function body(request: RecordedRequest): Record<string, unknown> {
  return JSON.parse(request.body ?? "{}") as Record<string, unknown>;
}

/** Answers each check by the recipient's local part: ok@, consent@, blocked@, unknown@, fail@. */
const byRecipient: Handler = (request) => {
  const email = String(body(request).recipient_email ?? "");
  if (email.startsWith("consent@")) return jsonResponse(200, CONSENT_PAYLOAD)(request);
  if (email.startsWith("blocked@")) return jsonResponse(200, BLOCKED_PAYLOAD)(request);
  if (email.startsWith("unknown@")) return jsonResponse(200, UNKNOWN_PAYLOAD)(request);
  if (email.startsWith("fail@")) return jsonResponse(500, { error: "server_error", message: "The check could not be completed." })(request);
  return jsonResponse(200, OK_PAYLOAD)(request);
};

function harness(handler: Handler = byRecipient, extra: Partial<CliIO> = {}) {
  const home = mkdtempSync(join(tmpdir(), "precleared-cli-"));
  const mock = new MockFetch(handler);
  const output = { stdout: "", stderr: "" };
  const sleeps: number[] = [];
  let clock = Date.parse("2026-10-28T12:00:00Z");
  const io: CliIO = {
    env: {},
    stdout: (text) => {
      output.stdout += text;
    },
    stderr: (text) => {
      output.stderr += text;
    },
    readStdin: async () => "",
    home,
    fetch: mock.fetch,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    minIntervalMs: 0,
    retryDelayMs: 0,
    ...extra,
  };
  const run = (...argv: string[]) => main(argv, io);
  const advance = (ms: number) => {
    clock += ms;
  };
  const checks = () => mock.requests.filter((request) => request.url.endsWith("/api/v1/check"));
  return { io, mock, home, output, sleeps, run, advance, checks };
}

function stdin(text: string): Partial<CliIO> {
  return { readStdin: async () => text };
}

describe("reading addresses", () => {
  it("finds the address in the usual shapes and lower-cases it", () => {
    expect(findEmail("Jane@Acme.co.uk")).toBe("jane@acme.co.uk");
    expect(findEmail("Jane Doe <jane@acme.co.uk>")).toBe("jane@acme.co.uk");
    expect(findEmail("mailto:jane@acme.co.uk")).toBe("jane@acme.co.uk");
    expect(findEmail("jane@acme.co.uk,Acme Ltd,London")).toBe("jane@acme.co.uk");
    expect(findEmail('"jane@acme.co.uk";"Acme"')).toBe("jane@acme.co.uk");
    expect(findEmail("Write to jane@acme.co.uk.")).toBe("jane@acme.co.uk");
    expect(findEmail("o'brien+sales@acme.ie")).toBe("o'brien+sales@acme.ie");
  });

  it("rejects what is not an address", () => {
    for (const line of ["+44 7700 900123", "jane@", "@acme.co.uk", "jane@acme", "jane@acme..uk", "jane @acme.co.uk"]) {
      expect(findEmail(line), line).toBeNull();
    }
  });

  it("skips blanks, notes and lines without an @, and reports lines with a broken address", () => {
    const parsed = parseAddressList("\ufeffjane@acme.co.uk\r\n\n# a note\n+44 7700 900123\nbroken@\nSam <sam@example.com>\n");
    expect(parsed).toEqual({ emails: ["jane@acme.co.uk", "sam@example.com"], invalid: ["broken@"], skipped: 1 });
  });
});

describe("precleared check", () => {
  it("exits 0 and prints send when every address may be emailed", async () => {
    const t = harness();
    expect(await t.run("check", "ok@acme.com")).toBe(EXIT_OK);
    expect(t.output.stdout).toBe("send   ok@acme.com  ok_to_email (us_canspam_ok), receipt cc_rcpt_363BBFMQ3YNSKA6A\n");
    expect(t.output.stderr).toMatch(/^1 address: 1 send, 0 hold, 0 errors\./);
    expect(t.output.stderr).toContain(`Each email you send to US must meet this: ${OK_PAYLOAD.footer_text}`);
    const [request] = t.checks();
    expect(body(request!)).toEqual({
      recipient_email: "ok@acme.com",
      sender_country: "GB",
      address_source: "unknown",
      existing_customer: false,
    });
    expect(request!.headers["User-Agent"]).toBe(`precleared-cli/${VERSION} (+https://www.npmjs.com/package/precleared)`);
    expect(request!.headers.Authorization).toBeUndefined();
  });

  it.each([
    ["consent@acme.com", "consent_needed (gb_individual_consent): Do not cold email."],
    ["blocked@acme.com", "blocked (any_suppressed): Do not email."],
    ["unknown@acme.com", "unknown (any_no_mx): Check the domain is spelt correctly."],
  ])("exits 2 and prints hold for %s", async (email, detail) => {
    const t = harness();
    expect(await t.run("check", email)).toBe(EXIT_HOLD);
    expect(t.output.stdout.startsWith(`hold   ${email}  ${detail}`)).toBe(true);
  });

  it("exits 1 when an address can't be checked, after the client's one retry", async () => {
    const t = harness();
    expect(await t.run("check", "fail@acme.com")).toBe(EXIT_ERROR);
    expect(t.checks()).toHaveLength(2);
    expect(t.output.stdout).toBe("error  fail@acme.com  The check could not be completed.\n");
  });

  it("lets a hold win over an error, and an error win over a send", async () => {
    const both = harness();
    expect(await both.run("check", "ok@acme.com", "fail@acme.com", "consent@acme.com")).toBe(EXIT_HOLD);
    const errorOnly = harness();
    expect(await errorOnly.run("check", "ok@acme.com", "fail@acme.com")).toBe(EXIT_ERROR);
  });

  it("reads a hook's standard input: emails and phone numbers, each address once", async () => {
    const t = harness(byRecipient, stdin("ok@acme.com\n+447700900123\nOK@ACME.COM\nconsent@acme.com\n"));
    expect(await t.run("check", "--stdin")).toBe(EXIT_HOLD);
    expect(t.checks().map((request) => body(request).recipient_email)).toEqual(["ok@acme.com", "consent@acme.com"]);
    expect(t.output.stdout.split("\n").filter(Boolean)).toHaveLength(2);
    expect(t.output.stderr).toContain("Skipped 1 line without an @.");
  });

  it("treats - as standard input and reports a broken address as an error", async () => {
    const t = harness(byRecipient, stdin("broken@\nok@acme.com\n"));
    expect(await t.run("check", "-")).toBe(EXIT_ERROR);
    expect(t.output.stdout).toContain("error  broken@  not a valid email address");
    expect(t.checks()).toHaveLength(1);
  });

  it("prints results in input order whatever order they finish in", async () => {
    const slowFirst: Handler = async (request) => {
      if (String(body(request).recipient_email).startsWith("a@")) await new Promise((resolve) => setTimeout(resolve, 30));
      return byRecipient(request);
    };
    const t = harness(slowFirst);
    expect(await t.run("check", "a@acme.com", "b@acme.com", "consent@acme.com")).toBe(EXIT_HOLD);
    expect(t.output.stdout.split("\n").filter(Boolean).map((line) => line.split(/\s+/)[1])).toEqual([
      "a@acme.com",
      "b@acme.com",
      "consent@acme.com",
    ]);
  });

  it("passes the options through, normalised", async () => {
    const t = harness();
    await t.run(
      "check",
      "ok@acme.com",
      "--sender-country",
      "us",
      "--address-source=Published",
      "--pitch",
      "Bookkeeping software",
      "--recipient-country",
      "uk",
      "--default-country",
      "ie",
      "--via",
      "cold-cli",
    );
    const [request] = t.checks();
    expect(body(request!)).toMatchObject({
      sender_country: "US",
      address_source: "published",
      pitch: "Bookkeeping software",
      recipient_country: "GB",
      default_recipient_country: "IE",
    });
    expect(request!.headers["User-Agent"]).toBe(`precleared-cli/${VERSION} (via cold-cli; +https://www.npmjs.com/package/precleared)`);
  });

  it("takes defaults from the environment", async () => {
    const t = harness(byRecipient, {
      env: { PRECLEARED_SENDER_COUNTRY: "AE", PRECLEARED_ADDRESS_SOURCE: "given", PRECLEARED_PITCH: "Audits" },
    });
    await t.run("check", "ok@acme.com");
    expect(body(t.checks()[0]!)).toMatchObject({ sender_country: "AE", address_source: "given", pitch: "Audits" });
  });

  it.each([
    [["check"], "Give one or more addresses"],
    [["check", "not-an-address"], '"not-an-address" is not an email address.'],
    [["check", "ok@acme.com", "--sender-country", "GBR"], "--sender-country must be a two-letter country code"],
    [["check", "ok@acme.com", "--address-source", "linkedin"], "--address-source must be one of published, bought, scraped, given, unknown."],
    [["check", "ok@acme.com", "--concurrency", "0"], "--concurrency must be a whole number from 1 to 16."],
    [["check", "ok@acme.com", "--timeout", "soon"], "--timeout must be a number from 1 to 300."],
    [["check", "ok@acme.com", "--via", "cold cli"], "--via must be a short name"],
    [["check", "ok@acme.com", "--frobnicate"], "Unknown option --frobnicate."],
    [["check", "ok@acme.com", "--pitch"], "--pitch needs a value."],
    [["check", "--json=yes", "ok@acme.com"], "--json takes no value."],
    [["send", "ok@acme.com"], 'Unknown command "send"'],
  ])("refuses %j with exit 1 and makes no request", async (argv, message) => {
    const t = harness();
    expect(await t.run(...argv)).toBe(EXIT_ERROR);
    expect(t.output.stderr).toContain(message);
    expect(t.output.stderr).toContain("precleared --help");
    expect(t.mock.requests).toHaveLength(0);
  });

  it("exits 1 when standard input holds no address", async () => {
    const t = harness(byRecipient, stdin("+447700900123\n\n"));
    expect(await t.run("check", "--stdin")).toBe(EXIT_ERROR);
    expect(t.output.stderr).toContain("No email addresses to check.");
    expect(t.mock.requests).toHaveLength(0);
  });

  it("prints JSON lines with --json", async () => {
    const t = harness();
    await t.run("check", "--json", "ok@acme.com", "consent@acme.com");
    const lines = t.output.stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({
      email: "ok@acme.com",
      decision: "send",
      verdict: "ok_to_email",
      rule: "us_canspam_ok",
      footer_text: OK_PAYLOAD.footer_text,
      recipient_country: "US",
      receipt_id: "cc_rcpt_363BBFMQ3YNSKA6A",
      receipt_url: "https://precleared.dev/r/cc_rcpt_363BBFMQ3YNSKA6A",
      cached: false,
    });
    expect(lines[1]).toMatchObject({ email: "consent@acme.com", decision: "hold", verdict: "consent_needed", next_step: CONSENT_PAYLOAD.next_step });
    expect(t.output.stderr).not.toContain("Each email you send");
  });

  it("prints nothing with --quiet", async () => {
    const t = harness();
    expect(await t.run("check", "-q", "consent@acme.com")).toBe(EXIT_HOLD);
    expect(t.output).toEqual({ stdout: "", stderr: "" });
  });

  it("passes on the API's heads-up about the allowance", async () => {
    const t = harness(jsonResponse(200, { ...OK_PAYLOAD, usage: { free_remaining_today: 2, notice: "2 free checks left today.\nGet a key: https://precleared.dev/get-key" } }));
    await t.run("check", "ok@acme.com");
    expect(t.output.stderr).toContain("2 free checks left today.\nGet a key: https://precleared.dev/get-key");
  });

  it("strips control characters from what the API says before printing it", async () => {
    const t = harness(jsonResponse(200, { ...CONSENT_PAYLOAD, next_step: "Hold\u001b]8;;https://bad.example\u0007 this\u001b[2J one." }));
    await t.run("check", "consent@acme.com");
    expect(t.output.stdout.replace(/\n/g, "")).not.toMatch(/[\u0000-\u001f]/u);
    expect(t.output.stdout).toContain("Hold ]8;;https://bad.example this [2J one.");
  });
});

describe("account-wide answers stop the run", () => {
  it("stops after the free daily allowance and suggests a key", async () => {
    const daily = jsonResponse(429, {
      error: "daily_limit",
      message: "The free allowance of 10 checks today is used.",
      operator_message: "Free checks for today are used. They reset at midnight UK time.",
      get_key_url: "https://precleared.dev/get-key",
      retry_after: 3600,
    });
    const t = harness(daily);
    expect(await t.run("check", "--concurrency", "1", "a@acme.com", "b@acme.com", "c@acme.com")).toBe(EXIT_ERROR);
    expect(t.checks()).toHaveLength(1);
    expect(t.output.stdout).toContain("error  b@acme.com  not checked: The free allowance of 10 checks today is used.");
    expect(t.output.stderr).toContain("Free checks for today are used. They reset at midnight UK time.");
    expect(t.output.stderr).toContain("Get a free key: precleared key --email you@yourcompany.com");
  });

  it("stops on 402 and shows where to buy checks", async () => {
    const t = harness(jsonResponse(402, { error: "payment_required", message: "Free checks used and no credits left.", buy_url: "https://precleared.dev/buy" }), {
      env: { PRECLEARED_API_KEY: KEY },
    });
    expect(await t.run("check", "--concurrency", "1", "a@acme.com", "b@acme.com")).toBe(EXIT_ERROR);
    expect(t.checks()).toHaveLength(1);
    expect(t.output.stderr).toContain("Free checks used and no credits left.");
    expect(t.output.stderr).toContain("Buy more checks: https://precleared.dev/buy");
    expect(t.output.stderr).not.toContain("precleared key --email");
  });

  it("stops on a bad key and says where the key came from, never the key", async () => {
    const t = harness(jsonResponse(401, { error: "invalid_key", message: "The API key is not valid." }), { env: { PRECLEARED_API_KEY: KEY } });
    expect(await t.run("check", "--concurrency", "1", "a@acme.com", "b@acme.com")).toBe(EXIT_ERROR);
    expect(t.checks()).toHaveLength(1);
    expect(t.output.stderr).toContain("The API key is not valid. Check the key in PRECLEARED_API_KEY.");
    expect(t.output.stdout + t.output.stderr).not.toContain(KEY);
  });

  it("waits and retries when the per-minute limit is hit", async () => {
    let calls = 0;
    const limited: Handler = (request) => {
      calls += 1;
      if (calls === 1) return jsonResponse(429, { error: "rate_limited", message: "Wait 7 seconds.", retry_after: 7 })(request);
      return byRecipient(request);
    };
    const t = harness(limited);
    expect(await t.run("check", "ok@acme.com")).toBe(EXIT_OK);
    expect(t.checks()).toHaveLength(2);
    expect(t.sleeps).toEqual([7000]);
  });

  it("spaces checks a second apart by default, so a key stays under 60 a minute", async () => {
    const t = harness(byRecipient, { minIntervalMs: undefined });
    await t.run("check", "--concurrency", "1", "a@acme.com", "b@acme.com", "c@acme.com");
    expect(t.sleeps).toEqual([1000, 1000]);
  });
});

describe("the key", () => {
  it("uses PRECLEARED_API_KEY", async () => {
    const t = harness(byRecipient, { env: { PRECLEARED_API_KEY: KEY } });
    await t.run("check", "ok@acme.com");
    expect(t.checks()[0]!.headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  it("uses ~/.precleared/key when the environment has none", async () => {
    const t = harness();
    mkdirSync(join(t.home, ".precleared"), { mode: 0o700 });
    writeFileSync(join(t.home, ".precleared", "key"), `${KEY}\n`, { mode: 0o600 });
    await t.run("check", "ok@acme.com");
    expect(t.checks()[0]!.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(t.output.stderr).not.toContain("Other users");
  });

  it("prefers --key-file, expanding ~, over the environment", async () => {
    const t = harness(byRecipient, { env: { PRECLEARED_API_KEY: "pc_live_fromenvironment000000000000000" } });
    writeFileSync(join(t.home, "other.key"), `# Precleared\n${KEY}\n`, { mode: 0o600 });
    await t.run("check", "ok@acme.com", "--key-file", "~/other.key");
    expect(t.checks()[0]!.headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  it.runIf(posix)("warns when other users can read the key file", async () => {
    const t = harness();
    const path = join(t.home, "shared.key");
    writeFileSync(path, KEY);
    chmodSync(path, 0o644);
    await t.run("check", "ok@acme.com", "--key-file", path);
    expect(t.output.stderr).toContain(`Other users on this computer can read ${path}. Run: chmod 600 ${path}`);
  });

  it("exits 1 when --key-file can't be read or is empty", async () => {
    const missing = harness();
    expect(await missing.run("check", "ok@acme.com", "--key-file", "/nonexistent/precleared.key")).toBe(EXIT_ERROR);
    expect(missing.output.stderr).toContain("Could not read the key file /nonexistent/precleared.key.");
    const empty = harness();
    writeFileSync(join(empty.home, "empty.key"), "\n");
    expect(await empty.run("check", "ok@acme.com", "--key-file", join(empty.home, "empty.key"))).toBe(EXIT_ERROR);
    expect(empty.output.stderr).toContain("is empty");
    expect(missing.mock.requests.length + empty.mock.requests.length).toBe(0);
  });
});

describe("the cache", () => {
  it("reuses a definite answer, keeps no addresses and doesn't keep unknown", async () => {
    const t = harness();
    expect(await t.run("check", "ok@acme.com", "consent@acme.com", "unknown@acme.com")).toBe(EXIT_HOLD);
    expect(t.checks()).toHaveLength(3);
    const file = join(t.home, ".precleared", "cache.json");
    const saved = readFileSync(file, "utf8");
    expect(saved).not.toContain("acme.com");
    expect(Object.keys((JSON.parse(saved) as { entries: object }).entries)).toHaveLength(2);
    if (posix) expect(statSync(file).mode & 0o777).toBe(0o600);

    t.output.stdout = "";
    expect(await t.run("check", "ok@acme.com", "consent@acme.com", "unknown@acme.com")).toBe(EXIT_HOLD);
    expect(t.checks()).toHaveLength(4);
    expect(t.output.stdout).toContain("send   ok@acme.com  ok_to_email (us_canspam_ok), receipt cc_rcpt_363BBFMQ3YNSKA6A, from the cache");
    expect(t.output.stdout).toContain("hold   consent@acme.com  consent_needed (gb_individual_consent), from the cache: Do not cold email.");
    expect(t.output.stderr).toContain("(2 from the cache)");
  });

  it("checks again when an input that changes the verdict changes", async () => {
    const t = harness();
    await t.run("check", "ok@acme.com");
    await t.run("check", "ok@acme.com", "--sender-country", "US");
    await t.run("check", "ok@acme.com", "--address-source", "published");
    expect(t.checks()).toHaveLength(3);
  });

  it("checks again once an answer is older than --cache-days", async () => {
    const t = harness();
    await t.run("check", "ok@acme.com", "--cache-days", "7");
    t.advance(6 * 86_400_000);
    await t.run("check", "ok@acme.com", "--cache-days", "7");
    expect(t.checks()).toHaveLength(1);
    t.advance(2 * 86_400_000);
    await t.run("check", "ok@acme.com", "--cache-days", "7");
    expect(t.checks()).toHaveLength(2);
  });

  it("uses no cache with --no-cache or --cache-days 0", async () => {
    const t = harness();
    await t.run("check", "ok@acme.com", "--no-cache");
    await t.run("check", "ok@acme.com", "--no-cache");
    await t.run("check", "ok@acme.com", "--cache-days", "0");
    expect(t.checks()).toHaveLength(3);
    expect(existsSync(join(t.home, ".precleared", "cache.json"))).toBe(false);
  });

  it("answers from the cache even after the allowance runs out", async () => {
    const t = harness();
    await t.run("check", "ok@acme.com");
    const daily = harness(jsonResponse(429, { error: "daily_limit", message: "Used up." }), { home: t.home });
    expect(await daily.run("check", "--concurrency", "1", "ok@acme.com", "new@acme.com")).toBe(EXIT_ERROR);
    expect(daily.checks()).toHaveLength(1);
    expect(daily.output.stdout).toContain("send   ok@acme.com");
    expect(daily.output.stdout).toContain("error  new@acme.com  Used up.");
  });

  it("rewrites a damaged cache", async () => {
    const t = harness();
    mkdirSync(join(t.home, ".precleared"));
    writeFileSync(join(t.home, ".precleared", "cache.json"), "{not json");
    expect(await t.run("check", "ok@acme.com")).toBe(EXIT_OK);
    expect(t.output.stderr).toContain("is damaged. It will be rewritten.");
    const saved = JSON.parse(readFileSync(join(t.home, ".precleared", "cache.json"), "utf8")) as { entries: object };
    expect(Object.keys(saved.entries)).toHaveLength(1);
  });
});

describe("the log", () => {
  it("adds one JSON line per address, never the key", async () => {
    const t = harness(byRecipient, { env: { PRECLEARED_API_KEY: KEY } });
    expect(await t.run("check", "ok@acme.com", "consent@acme.com", "--log", "~/logs/precleared.log", "--via", "cold-cli")).toBe(EXIT_HOLD);
    const file = join(t.home, "logs", "precleared.log");
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain(KEY);
    const lines = text.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      time: "2026-10-28T12:00:00.000Z",
      email: "ok@acme.com",
      decision: "send",
      verdict: "ok_to_email",
      receipt_id: "cc_rcpt_363BBFMQ3YNSKA6A",
      sender_country: "GB",
      address_source: "unknown",
      via: "cold-cli",
      version: VERSION,
    });
    expect(lines[1]).toMatchObject({ email: "consent@acme.com", decision: "hold", next_step: CONSENT_PAYLOAD.next_step });
    if (posix) expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("logs even with --quiet, and takes PRECLEARED_LOG", async () => {
    const t = harness();
    t.io.env.PRECLEARED_LOG = join(t.home, "hook.log");
    await t.run("check", "-q", "ok@acme.com");
    expect(t.output.stdout).toBe("");
    expect(readFileSync(join(t.home, "hook.log"), "utf8")).toContain('"email":"ok@acme.com"');
  });
});

describe("precleared key", () => {
  const made = { key: KEY, key_prefix: KEY.slice(0, 12), free_per_day: 25, message: "Save it now. We only store a hash." };

  it("saves a free key only its owner can read, and never prints it", async () => {
    const t = harness(jsonResponse(201, made));
    expect(await t.run("key", "--email", "Jo@Example.com", "--country", "gb", "--via", "cold-cli")).toBe(EXIT_OK);
    const [request] = t.mock.requests;
    expect(request!.url).toBe("https://precleared.dev/api/v1/keys");
    expect(body(request!)).toEqual({
      email: "jo@example.com",
      use_case: "precleared command line (via cold-cli): cold-email check before sending",
      country: "GB",
    });
    expect(request!.headers.Authorization).toBeUndefined();
    const file = join(t.home, ".precleared", "key");
    expect(readFileSync(file, "utf8")).toBe(`${KEY}\n`);
    if (posix) expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(t.output.stdout).toContain(`Saved a free key for jo@example.com in ${file}`);
    expect(t.output.stdout).toContain("100 checks a day for their first 14 days, then 25 a day");
    expect(t.output.stdout + t.output.stderr).not.toContain(KEY);
  });

  it("then check uses it", async () => {
    const t = harness(jsonResponse(201, made));
    await t.run("key", "--email", "jo@example.com");
    const check = harness(byRecipient, { home: t.home });
    await check.run("check", "ok@acme.com");
    expect(check.checks()[0]!.headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  it("keeps a key that is already saved unless --force", async () => {
    const t = harness(jsonResponse(201, made));
    mkdirSync(join(t.home, ".precleared"));
    writeFileSync(join(t.home, ".precleared", "key"), "pc_live_existingexistingexistingexist\n");
    expect(await t.run("key", "--email", "jo@example.com")).toBe(EXIT_OK);
    expect(t.mock.requests).toHaveLength(0);
    expect(t.output.stdout).toContain("Kept it. Use --force to replace it.");
    expect(await t.run("key", "--email", "jo@example.com", "--force")).toBe(EXIT_OK);
    expect(readFileSync(join(t.home, ".precleared", "key"), "utf8")).toBe(`${KEY}\n`);
  });

  it.each([
    [429, { error: "too_many_keys", message: "This email address already has three keys." }, "couldn't get a key: This email address already has three keys."],
    [400, { error: "invalid_request", message: "Give a valid email address." }, "couldn't get a key: Give a valid email address."],
    [500, "<html>oops</html>", "couldn't get a key: Precleared answered HTTP 500."],
  ])("says why no key came back (HTTP %s) and saves nothing", async (status, payload, message) => {
    const t = harness(typeof payload === "string" ? () => rawResponse(status, payload) : jsonResponse(status, payload));
    expect(await t.run("key", "--email", "jo@example.com")).toBe(EXIT_ERROR);
    expect(t.output.stderr).toContain(message);
    expect(t.output.stderr.includes("https://precleared.dev/get-key")).toBe(status === 429);
    expect(existsSync(join(t.home, ".precleared", "key"))).toBe(false);
  });

  it("refuses an answer without a usable key", async () => {
    const t = harness(jsonResponse(201, { key: "has spaces in it" }));
    expect(await t.run("key", "--email", "jo@example.com")).toBe(EXIT_ERROR);
    expect(t.output.stderr).toContain("Precleared's answer had no key in it.");
    expect(existsSync(join(t.home, ".precleared", "key"))).toBe(false);
  });

  it.each([
    [["key"], "key needs --email"],
    [["key", "--email", "jo"], '"jo" is not an email address.'],
    [["key", "--email", "Jo <jo@example.com>"], "is not an email address."],
    [["key", "jo@example.com"], "key takes its address with --email."],
  ])("refuses %j", async (argv, message) => {
    const t = harness(jsonResponse(201, made));
    expect(await t.run(...argv)).toBe(EXIT_ERROR);
    expect(t.output.stderr).toContain(message);
    expect(t.mock.requests).toHaveLength(0);
  });
});

describe("help and version", () => {
  it("prints the version", async () => {
    const t = harness();
    expect(await t.run("--version")).toBe(EXIT_OK);
    expect(t.output.stdout).toBe(`${VERSION}\n`);
  });

  it("prints help with --help and exits 1 with no command", async () => {
    const help = harness();
    expect(await help.run("--help")).toBe(EXIT_OK);
    expect(help.output.stdout).toBe(HELP);
    const check = harness();
    expect(await check.run("check", "--help")).toBe(EXIT_OK);
    const none = harness();
    expect(await none.run()).toBe(EXIT_ERROR);
    expect(none.output.stderr).toBe(HELP);
  });
});
