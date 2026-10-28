/**
 * The `precleared` command: check addresses from a shell or a pre-send hook,
 * and get a free key.
 *
 *     precleared check jane@acme.co.uk
 *     precleared check --stdin < leads.txt
 *     precleared key --email you@yourcompany.com
 *
 * `check` exits 0 when every address may be emailed, 2 when at least one must
 * be held (consent_needed, blocked or unknown) and 1 when an address could not
 * be checked or the command was used wrongly. A hold wins over an error, so a
 * hook that suppresses on 2 never sends to a held address.
 *
 * The key comes from --key-file, then PRECLEARED_API_KEY, then
 * ~/.precleared/key. It is never printed, logged or cached.
 */

import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

import { Precleared, type FetchLike, type FetchRequestInit } from "./client";
import { AuthError, PaymentRequiredError, RateLimitError, isPreclearedError } from "./errors";
import { decidingRule, isRecord, receiptUrl } from "./result";
import { ADDRESS_SOURCES, DEFAULT_BASE_URL, type AddressSource, type CheckResult, type Verdict } from "./types";
import { VERSION } from "./version";

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_HOLD = 2;

/** Where `key` saves a key and `check` looks for one, under the home folder. */
export const KEY_FILE = join(".precleared", "key");
/** Where `check` keeps definite answers, under the home folder. */
export const CACHE_FILE = join(".precleared", "cache.json");

const DEFAULT_CACHE_DAYS = 30;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_SECONDS = 30;
/** One check a second at most: 60 a minute, the per-key limit. */
const DEFAULT_MIN_INTERVAL_MS = 1000;
const RATE_LIMIT_RETRIES = 3;
const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const PRIVACY_URL = "https://precleared.dev/privacy";
const GET_KEY_URL = "https://precleared.dev/get-key";
const GET_KEY_HINT = "precleared key --email you@yourcompany.com";
const CACHEABLE = new Set<Verdict>(["ok_to_email", "consent_needed", "blocked"]);

export const HELP = `precleared ${VERSION}: is it legal to send this person a cold email?

Usage:
  precleared check [options] <address>...
  precleared check --stdin [options] < addresses.txt
  precleared key --email <address> [--country GB]

check
  Checks each address once and prints send, hold or error for it.
  Exit code: 0 every address may be emailed; 2 at least one must be held
  (consent_needed, blocked or unknown); 1 something could not be checked.

  --stdin                 Read addresses from standard input, one per line.
                          Lines without an @ (phone numbers, blanks, # notes)
                          are skipped.
  --sender-country CC     Where you send from: GB, US or AE. Default GB.
  --address-source SRC    How you got the addresses: published, bought,
                          scraped, given or unknown. Default unknown.
  --pitch TEXT            What you are offering, in one sentence.
  --recipient-country CC  The recipients' country, when you know it.
  --default-country CC    Used only when the country can't be worked out.
  --json                  One JSON object per address on standard output.
  --log FILE              Add a JSON line per address to FILE.
  --cache FILE            Where answers are kept. Default ~/.precleared/cache.json
  --cache-days N          Reuse a definite answer for N days. Default 30.
  --no-cache              Don't read or write the cache.
  --key-file FILE         Read the API key from FILE.
  --concurrency N         Checks at a time. Default 4, at most 60 a minute.
  --timeout SECONDS       Per check. Default 30.
  --via NAME              The tool running this command, for example cold-cli.
  -q, --quiet             Print nothing. Use the exit code.

key
  Gets a free key and saves it in ~/.precleared/key, where check finds it.
  New keys get 100 checks a day for their first 14 days, then 25 a day.
  The key is never printed.

  --email ADDRESS         Required. Precleared receives it to make the key
                          (privacy: ${PRIVACY_URL}).
  --country CC            Where you send from.
  --key-file FILE         Save the key in FILE instead.
  --force                 Replace a key that is already saved.

The key: --key-file, then PRECLEARED_API_KEY, then ~/.precleared/key. Without
one: 10 checks a day per network. Docs: https://precleared.dev/docs
Decision support with sources, not legal advice.
`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Everything the command touches outside itself, so tests can stand in for it. */
export interface CliIO {
  env: Record<string, string | undefined>;
  stdout(text: string): void;
  stderr(text: string): void;
  readStdin(): Promise<string>;
  /** The home folder: ~/.precleared lives here, and paths starting ~/ start here. */
  home: string;
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Gap between the starts of two checks. Default 1000 ms. */
  minIntervalMs?: number;
  /** The client's pause before a retry. Default 300 ms. */
  retryDelayMs?: number;
}

export type Decision = "send" | "hold" | "error";

/** One line of output, log or JSON: what happened to one address. */
export interface Outcome {
  email: string;
  decision: Decision;
  verdict?: Verdict;
  rule?: string | null;
  next_step?: string | null;
  footer_text?: string | null;
  recipient_country?: string | null;
  receipt_id?: string | null;
  receipt_url?: string | null;
  cached?: boolean;
  error?: string;
  message?: string;
}

/** A problem with how the command was run: printed, exit 1. */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

/** A malformed command line: printed with a pointer to --help, exit 1. */
export class UsageError extends CliError {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Run the command with `argv` (the arguments after the program name). Resolves to the exit code. */
export async function main(argv: readonly string[], io: CliIO): Promise<number> {
  try {
    const [command, ...rest] = argv;
    if (command === undefined) {
      io.stderr(HELP);
      return EXIT_ERROR;
    }
    if (command === "--version" || command === "-v" || command === "version") {
      io.stdout(`${VERSION}\n`);
      return EXIT_OK;
    }
    if (command === "--help" || command === "-h" || command === "help") {
      io.stdout(HELP);
      return EXIT_OK;
    }
    if (command === "check") return await checkCommand(rest, io);
    if (command === "key") return await keyCommand(rest, io);
    throw new UsageError(`Unknown command "${clean(command, 60)}". Use check or key.`);
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`precleared: ${error.message}\nRun precleared --help to see the options.\n`);
    } else if (error instanceof CliError) {
      io.stderr(`precleared: ${error.message}\n`);
    } else {
      io.stderr(`precleared: ${clean(error instanceof Error ? error.message : String(error))}\n`);
    }
    return EXIT_ERROR;
  }
}

// ---------------------------------------------------------------------------
// Command-line parsing
// ---------------------------------------------------------------------------

type OptionKind = "flag" | "value";
type Options = Map<string, string | true>;

const CHECK_SPEC: Record<string, OptionKind> = {
  stdin: "flag",
  "sender-country": "value",
  "address-source": "value",
  pitch: "value",
  "recipient-country": "value",
  "default-country": "value",
  json: "flag",
  log: "value",
  cache: "value",
  "cache-days": "value",
  "no-cache": "flag",
  "key-file": "value",
  concurrency: "value",
  timeout: "value",
  via: "value",
  quiet: "flag",
  "base-url": "value",
  help: "flag",
};

const KEY_SPEC: Record<string, OptionKind> = {
  email: "value",
  country: "value",
  name: "value",
  company: "value",
  "key-file": "value",
  force: "flag",
  via: "value",
  timeout: "value",
  "base-url": "value",
  help: "flag",
};

const SHORT: Record<string, string> = { "-q": "quiet", "-h": "help" };

export function parseOptions(args: readonly string[], spec: Record<string, OptionKind>): { options: Options; positionals: string[] } {
  const options: Options = new Map();
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    let name: string;
    let inline: string | undefined;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      inline = eq === -1 ? undefined : arg.slice(eq + 1);
    } else if (SHORT[arg] !== undefined) {
      name = SHORT[arg] as string;
    } else if (arg.startsWith("-") && arg !== "-") {
      throw new UsageError(`Unknown option ${clean(arg, 60)}.`);
    } else {
      positionals.push(arg);
      continue;
    }
    const kind = spec[name];
    if (kind === undefined) throw new UsageError(`Unknown option --${clean(name, 60)}.`);
    if (kind === "flag") {
      if (inline !== undefined) throw new UsageError(`--${name} takes no value.`);
      options.set(name, true);
      continue;
    }
    let value = inline;
    if (value === undefined) {
      const next = args[i + 1];
      if (next === undefined || (next.startsWith("-") && next !== "-")) throw new UsageError(`--${name} needs a value.`);
      value = next;
      i += 1;
    }
    options.set(name, value);
  }
  return { options, positionals };
}

function optionText(options: Options, name: string): string | undefined {
  const value = options.get(name);
  return typeof value === "string" ? text(value) : undefined;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function countryValue(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  const upper = value.toUpperCase();
  const code = upper === "UK" ? "GB" : upper;
  if (!/^[A-Z]{2}$/.test(code)) throw new UsageError(`${name} must be a two-letter country code such as GB.`);
  return code;
}

function sourceValue(value: string | undefined): AddressSource | undefined {
  if (value === undefined) return undefined;
  const lower = value.toLowerCase();
  const match = ADDRESS_SOURCES.find((source) => source === lower);
  if (!match) throw new UsageError(`--address-source must be one of ${ADDRESS_SOURCES.join(", ")}.`);
  return match;
}

function numberValue(value: string | undefined, name: string, fallback: number, min: number, max: number, whole: boolean): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max || (whole && !Number.isInteger(number))) {
    throw new UsageError(`${name} must be ${whole ? "a whole number" : "a number"} from ${min} to ${max}.`);
  }
  return number;
}

function viaValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(value)) {
    throw new UsageError("--via must be a short name of letters, digits, dots, dashes or underscores.");
  }
  return value;
}

function baseUrlValue(options: Options, io: CliIO): string {
  const value = optionText(options, "base-url") ?? text(io.env.PRECLEARED_BASE_URL) ?? DEFAULT_BASE_URL;
  if (!/^https?:\/\/[^\s/]+/i.test(value)) throw new UsageError("--base-url must start with http:// or https://.");
  return value.replace(/\/+$/, "");
}

function userAgent(via: string | undefined): string {
  return `precleared-cli/${VERSION} (${via ? `via ${via}; ` : ""}+https://www.npmjs.com/package/precleared)`;
}

/** Expand a leading ~ (hooks run the command without a shell, so nothing else will). */
export function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(home, path.slice(2));
  return path;
}

/** Flatten control characters, so nothing a server sends can drive the terminal. */
export function clean(value: unknown, max = 600): string {
  const raw = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
  const flat = raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/** `clean`, keeping line breaks: for the multi-line messages the API writes for people. */
function cleanLines(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .split(/\r?\n/)
    .map((line) => clean(line))
    .filter((line) => line !== "")
    .join("\n");
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

const EMAIL_TOKEN = /[^\s<>()[\],;:"|]+@[^\s<>()[\],;:"|]+/;
const EMAIL_SHAPE = /^[a-z0-9.!#$%&'*+/=?^_`{}~-]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;

/**
 * The first email address in a line, lower-cased, or null. Handles a bare
 * address, `Jane <jane@acme.co.uk>`, `mailto:` and the first column of a CSV.
 */
export function findEmail(line: string): string | null {
  const match = EMAIL_TOKEN.exec(line);
  if (!match) return null;
  const email = match[0].replace(/\.+$/, "").toLowerCase();
  return email.length <= 254 && EMAIL_SHAPE.test(email) ? email : null;
}

/**
 * Read addresses from text, one per line. Blank lines, `#` notes and lines
 * with no @ (such as the phone numbers a hook may pass) are skipped; a line
 * with an @ but no valid address is returned as invalid, so it is reported
 * rather than dropped.
 */
export function parseAddressList(input: string): { emails: string[]; invalid: string[]; skipped: number } {
  const emails: string[] = [];
  const invalid: string[] = [];
  let skipped = 0;
  for (const raw of input.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (!line.includes("@")) {
      skipped += 1;
      continue;
    }
    const email = findEmail(line);
    if (email) emails.push(email);
    else invalid.push(clean(line, 120));
  }
  return { emails, invalid, skipped };
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

/** Write a file only its owner can read, atomically (a temporary file, then a rename). */
async function writePrivate(path: string, content: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, path);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function keyShapeOk(key: string): boolean {
  // Printable ASCII with no spaces: it goes in an HTTP header.
  return /^[!-~]{8,300}$/.test(key);
}

async function readKeyFile(path: string, required: boolean, warn: (line: string) => void): Promise<string | null> {
  let content: string;
  try {
    content = await fs.readFile(path, "utf8");
  } catch (error) {
    if (!required && errorCode(error) === "ENOENT") return null;
    throw new CliError(`Could not read the key file ${path}.`);
  }
  const key = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== "" && !line.startsWith("#"));
  if (!key) {
    if (required) throw new CliError(`The key file ${path} is empty.`);
    warn(`${path} is empty, so no key is used.`);
    return null;
  }
  if (!keyShapeOk(key)) throw new CliError(`The key in ${path} doesn't look like a Precleared key.`);
  if (process.platform !== "win32") {
    try {
      const { mode } = await fs.stat(path);
      if (mode & 0o077) warn(`Other users on this computer can read ${path}. Run: chmod 600 ${path}`);
    } catch {
      // The key was read; the permission hint is only a hint.
    }
  }
  return key;
}

interface KeyChoice {
  key: string | null;
  from: string;
}

async function resolveKey(options: Options, io: CliIO, warn: (line: string) => void): Promise<KeyChoice> {
  const explicit = optionText(options, "key-file") ?? text(io.env.PRECLEARED_KEY_FILE);
  if (explicit) {
    const path = expandHome(explicit, io.home);
    return { key: await readKeyFile(path, true, warn), from: path };
  }
  const fromEnv = text(io.env.PRECLEARED_API_KEY);
  if (fromEnv) {
    if (!keyShapeOk(fromEnv)) throw new CliError("PRECLEARED_API_KEY doesn't look like a Precleared key.");
    return { key: fromEnv, from: "PRECLEARED_API_KEY" };
  }
  const path = join(io.home, KEY_FILE);
  const key = await readKeyFile(path, false, warn);
  return key ? { key, from: path } : { key: null, from: "" };
}

interface CacheEntry {
  /** Verdict. */
  v: Verdict;
  /** Deciding rule. */
  r: string | null;
  /** Receipt id. */
  id: string | null;
  /** Next step, kept for holds. */
  n?: string | null;
  /** When it was checked, in milliseconds. */
  at: number;
}

function validEntry(value: unknown): value is CacheEntry {
  return (
    isRecord(value) &&
    typeof value.v === "string" &&
    CACHEABLE.has(value.v as Verdict) &&
    typeof value.at === "number" &&
    Number.isFinite(value.at)
  );
}

/**
 * Definite answers (ok_to_email, consent_needed, blocked), so follow-ups to
 * the same person don't spend another check. Entries are keyed by a SHA-256
 * of the address and every input that can change the verdict: the file holds
 * no addresses. `unknown` is never kept, as a later check may settle it.
 */
class AnswerCache {
  readonly path: string;
  readonly #maxAgeMs: number;
  readonly #now: () => number;
  #entries: Record<string, CacheEntry> = {};
  #dirty = false;
  #usable = true;

  constructor(path: string, maxAgeMs: number, now: () => number) {
    this.path = path;
    this.#maxAgeMs = maxAgeMs;
    this.#now = now;
  }

  async load(warn: (line: string) => void): Promise<void> {
    const read = await this.#read();
    if (read === "missing") return;
    if (read === "unreadable") {
      warn(`Could not read the cache at ${this.path}, so it is not used.`);
      this.#usable = false;
      return;
    }
    if (read === "corrupt") {
      warn(`The cache at ${this.path} is damaged. It will be rewritten.`);
      this.#dirty = true;
      return;
    }
    this.#entries = read;
  }

  get(key: string): CacheEntry | undefined {
    if (!this.#usable) return undefined;
    const entry = this.#entries[key];
    if (!entry) return undefined;
    const age = this.#now() - entry.at;
    return age >= 0 && age <= this.#maxAgeMs ? entry : undefined;
  }

  set(key: string, entry: CacheEntry): void {
    if (!this.#usable) return;
    this.#entries[key] = entry;
    this.#dirty = true;
  }

  /** Merge with what another run may have saved meanwhile, drop old entries and write. */
  async save(warn: (line: string) => void): Promise<void> {
    if (!this.#usable || !this.#dirty) return;
    const latest = await this.#read();
    const merged: Record<string, CacheEntry> = typeof latest === "object" ? latest : {};
    for (const [key, entry] of Object.entries(this.#entries)) {
      const other = merged[key];
      if (!other || other.at <= entry.at) merged[key] = entry;
    }
    const now = this.#now();
    const kept: Record<string, CacheEntry> = {};
    for (const [key, entry] of Object.entries(merged)) {
      if (now - entry.at <= this.#maxAgeMs) kept[key] = entry;
    }
    try {
      await writePrivate(this.path, `${JSON.stringify({ version: 1, entries: kept })}\n`);
      this.#dirty = false;
    } catch {
      warn(`Could not save the cache at ${this.path}.`);
    }
  }

  async #read(): Promise<Record<string, CacheEntry> | "missing" | "unreadable" | "corrupt"> {
    let raw: string;
    try {
      raw = await fs.readFile(this.path, "utf8");
    } catch (error) {
      return errorCode(error) === "ENOENT" ? "missing" : "unreadable";
    }
    try {
      const data: unknown = JSON.parse(raw);
      if (!isRecord(data) || data.version !== 1 || !isRecord(data.entries)) return "corrupt";
      const entries: Record<string, CacheEntry> = {};
      for (const [key, entry] of Object.entries(data.entries)) {
        if (/^[0-9a-f]{64}$/.test(key) && validEntry(entry)) entries[key] = entry;
      }
      return entries;
    } catch {
      return "corrupt";
    }
  }
}

function cacheKey(parts: Array<string | undefined>): string {
  return createHash("sha256")
    .update(JSON.stringify(["precleared-cli/1", ...parts.map((part) => part ?? "")]))
    .digest("hex");
}

/** Appends one JSON line per address. Never the key. */
class LogFile {
  readonly path: string;
  #chain: Promise<void> = Promise.resolve();
  #failed = false;

  constructor(path: string) {
    this.path = path;
  }

  write(record: Record<string, unknown>, warn: (line: string) => void): void {
    const line = `${JSON.stringify(record)}\n`;
    this.#chain = this.#chain.then(async () => {
      if (this.#failed) return;
      try {
        await fs.mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        await fs.appendFile(this.path, line, { mode: 0o600 });
      } catch {
        this.#failed = true;
        warn(`Could not write to the log at ${this.path}.`);
      }
    });
  }

  flush(): Promise<void> {
    return this.#chain;
  }
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

/** Spaces out the starts of checks, and holds everyone back after a 429. */
class Pacer {
  #next = 0;
  readonly #gapMs: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(gapMs: number, now: () => number, sleep: (ms: number) => Promise<void>) {
    this.#gapMs = gapMs;
    this.#now = now;
    this.#sleep = sleep;
  }

  async wait(): Promise<void> {
    const now = this.#now();
    const start = Math.max(now, this.#next);
    this.#next = start + this.#gapMs;
    if (start > now) await this.#sleep(start - now);
  }

  holdOff(ms: number): void {
    this.#next = Math.max(this.#next, this.#now() + ms);
  }
}

interface Settings {
  sender_country: string;
  address_source: AddressSource;
  pitch?: string;
  recipient_country?: string;
  default_recipient_country?: string;
}

interface Stop {
  code: string;
  /** One line, for the address lines. */
  message: string;
  /** What to tell the person at the end: the API's own words where it gave some. */
  detail: string;
}

function decisionFor(verdict: Verdict): Decision {
  return verdict === "ok_to_email" ? "send" : "hold";
}

function outcomeFromResult(email: string, result: CheckResult, baseUrl: string): Outcome {
  const rule = decidingRule(result) ?? result.rules_applied[0] ?? null;
  return {
    email,
    decision: decisionFor(result.verdict),
    verdict: result.verdict,
    rule,
    next_step: result.next_step,
    footer_text: result.footer_text,
    recipient_country: typeof result.facts.recipient_country === "string" ? result.facts.recipient_country : null,
    receipt_id: result.receipt?.id ?? null,
    receipt_url: receiptUrl(result, baseUrl),
    cached: false,
  };
}

function outcomeFromCache(email: string, entry: CacheEntry, baseUrl: string): Outcome {
  return {
    email,
    decision: decisionFor(entry.v),
    verdict: entry.v,
    rule: entry.r,
    next_step: entry.n ?? null,
    receipt_id: entry.id,
    receipt_url: entry.id ? receiptUrl(entry.id, baseUrl) : null,
    cached: true,
  };
}

function bodyText(error: { body: Record<string, unknown> }, field: string): string | undefined {
  return text(error.body[field]);
}

/** Errors that stop every remaining check: the key, the allowance or payment. */
function accountStop(error: unknown, keyFrom: string): Stop | null {
  if (error instanceof AuthError) {
    const where = keyFrom ? ` Check the key in ${keyFrom}.` : "";
    return { code: error.code ?? "invalid_key", message: clean(error.message), detail: `${clean(error.message)}${where}` };
  }
  if (error instanceof PaymentRequiredError) {
    const lines = [cleanLines(bodyText(error, "operator_message") ?? error.message)];
    if (error.buyUrl && !lines.join("\n").includes(error.buyUrl)) lines.push(`Buy more checks: ${clean(error.buyUrl)}`);
    return { code: "payment_required", message: clean(error.message), detail: lines.join("\n") };
  }
  if (error instanceof RateLimitError && error.kind === "daily_limit") {
    const lines = [cleanLines(bodyText(error, "operator_message") ?? error.message)];
    if (!keyFrom) lines.push(`Get a free key: ${GET_KEY_HINT}`);
    return { code: "daily_limit", message: clean(error.message), detail: lines.join("\n") };
  }
  return null;
}

function outcomeFromError(email: string, error: unknown): Outcome {
  if (isPreclearedError(error)) {
    return { email, decision: "error", error: error.code ?? "error", message: clean(error.message) };
  }
  return { email, decision: "error", error: "error", message: clean(error instanceof Error ? error.message : String(error)) };
}

function humanLine(outcome: Outcome): string {
  const label = outcome.decision.padEnd(5);
  if (outcome.decision === "error") return `${label}  ${outcome.email}  ${outcome.message ?? "could not be checked"}`;
  const rule = outcome.rule ? ` (${clean(outcome.rule, 80)})` : "";
  const cached = outcome.cached ? ", from the cache" : "";
  if (outcome.decision === "send") {
    const receipt = outcome.receipt_id ? `, receipt ${clean(outcome.receipt_id, 80)}` : "";
    return `${label}  ${outcome.email}  ${outcome.verdict}${rule}${receipt}${cached}`;
  }
  const next = outcome.next_step ? `: ${clean(outcome.next_step)}` : "";
  return `${label}  ${outcome.email}  ${outcome.verdict}${rule}${cached}${next}`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

async function checkCommand(args: readonly string[], io: CliIO): Promise<number> {
  const { options, positionals } = parseOptions(args, CHECK_SPEC);
  if (options.has("help")) {
    io.stdout(HELP);
    return EXIT_OK;
  }
  const env = io.env;
  const quiet = options.has("quiet");
  const asJson = options.has("json");
  const warnings: string[] = [];
  const warn = (line: string) => {
    if (!warnings.includes(line)) warnings.push(line);
  };

  const settings: Settings = {
    sender_country: countryValue(optionText(options, "sender-country") ?? text(env.PRECLEARED_SENDER_COUNTRY), "--sender-country") ?? "GB",
    address_source: sourceValue(optionText(options, "address-source") ?? text(env.PRECLEARED_ADDRESS_SOURCE)) ?? "unknown",
  };
  const pitch = optionText(options, "pitch") ?? text(env.PRECLEARED_PITCH);
  if (pitch) settings.pitch = pitch;
  const recipientCountry = countryValue(optionText(options, "recipient-country"), "--recipient-country");
  if (recipientCountry) settings.recipient_country = recipientCountry;
  const defaultCountry = countryValue(optionText(options, "default-country"), "--default-country");
  if (defaultCountry) settings.default_recipient_country = defaultCountry;

  const cacheDays = numberValue(optionText(options, "cache-days"), "--cache-days", DEFAULT_CACHE_DAYS, 0, 365, true);
  const concurrency = numberValue(optionText(options, "concurrency"), "--concurrency", DEFAULT_CONCURRENCY, 1, 16, true);
  const timeoutSeconds = numberValue(optionText(options, "timeout"), "--timeout", DEFAULT_TIMEOUT_SECONDS, 1, 300, false);
  const via = viaValue(optionText(options, "via"));
  const baseUrl = baseUrlValue(options, io);
  const logPath = optionText(options, "log") ?? text(env.PRECLEARED_LOG);
  const cachePath = optionText(options, "cache") ?? text(env.PRECLEARED_CACHE);

  // Addresses: the arguments, then standard input.
  const emails: string[] = [];
  const invalid: string[] = [];
  let skipped = 0;
  let readStdin = options.has("stdin");
  for (const arg of positionals) {
    if (arg === "-") {
      readStdin = true;
      continue;
    }
    const email = findEmail(arg);
    if (!email) throw new UsageError(`"${clean(arg, 80)}" is not an email address.`);
    emails.push(email);
  }
  if (readStdin) {
    const input = await io.readStdin();
    if (input.length > MAX_INPUT_BYTES) throw new CliError("The input is larger than 20 MB. Split it up.");
    const parsed = parseAddressList(input);
    emails.push(...parsed.emails);
    invalid.push(...parsed.invalid);
    skipped = parsed.skipped;
  } else if (positionals.length === 0) {
    throw new UsageError("Give one or more addresses, or --stdin to read them from standard input.");
  }
  const unique = [...new Set(emails)];
  if (unique.length === 0 && invalid.length === 0) throw new CliError("No email addresses to check.");

  const keyChoice = await resolveKey(options, io, warn);
  const now = io.now ?? Date.now;
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const client = new Precleared({
    apiKey: keyChoice.key,
    baseUrl,
    timeoutMs: timeoutSeconds * 1000,
    userAgent: userAgent(via),
    ...(io.fetch ? { fetch: io.fetch } : {}),
    ...(io.retryDelayMs !== undefined ? { retryDelayMs: io.retryDelayMs } : {}),
  });

  const cache =
    options.has("no-cache") || cacheDays === 0
      ? null
      : new AnswerCache(expandHome(cachePath ?? join(io.home, CACHE_FILE), io.home), cacheDays * 86_400_000, now);
  await cache?.load(warn);
  const log = logPath ? new LogFile(expandHome(logPath, io.home)) : null;
  const pacer = new Pacer(io.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS, now, sleep);

  // Results print in input order as they arrive: invalid lines first, then each address.
  const outcomes: Array<Outcome | undefined> = [];
  let printed = 0;
  const footers = new Map<string, Set<string>>();
  const emit = (outcome: Outcome) => {
    if (!quiet) io.stdout(`${asJson ? JSON.stringify(outcome) : humanLine(outcome)}\n`);
    if (log) {
      log.write(
        {
          time: new Date(now()).toISOString(),
          ...outcome,
          sender_country: settings.sender_country,
          address_source: settings.address_source,
          ...(via ? { via } : {}),
          version: VERSION,
        },
        warn,
      );
    }
    if (outcome.decision === "send" && outcome.footer_text) {
      const footer = clean(outcome.footer_text, 2000);
      const countries = footers.get(footer) ?? new Set<string>();
      if (outcome.recipient_country) countries.add(clean(outcome.recipient_country, 10));
      footers.set(footer, countries);
    }
  };
  const record = (index: number, outcome: Outcome) => {
    outcomes[index] = outcome;
    while (printed < outcomes.length && outcomes[printed] !== undefined) {
      emit(outcomes[printed] as Outcome);
      printed += 1;
    }
  };

  const offset = invalid.length;
  invalid.forEach((line, index) =>
    record(index, { email: line, decision: "error", error: "invalid_address", message: "not a valid email address" }),
  );

  // Asserted, so TypeScript doesn't narrow it to null: the workers set it.
  let stop = null as Stop | null;
  let notice = "";
  const checkOne = async (email: string): Promise<Outcome> => {
    const key = cache
      ? cacheKey([
          baseUrl,
          email,
          settings.sender_country,
          settings.address_source,
          settings.pitch,
          settings.recipient_country,
          settings.default_recipient_country,
        ])
      : "";
    const hit = cache?.get(key);
    if (hit) return outcomeFromCache(email, hit, baseUrl);
    for (let attempt = 0; ; attempt += 1) {
      if (!stop) await pacer.wait();
      if (stop) return { email, decision: "error", error: "not_checked", message: `not checked: ${stop.message}` };
      try {
        const result = await client.check({ recipient_email: email, ...settings });
        if (result.usage?.notice) notice = cleanLines(result.usage.notice);
        const outcome = outcomeFromResult(email, result, baseUrl);
        if (cache && CACHEABLE.has(result.verdict)) {
          cache.set(key, {
            v: result.verdict,
            r: outcome.rule ?? null,
            id: outcome.receipt_id ?? null,
            ...(result.verdict === "ok_to_email" ? {} : { n: result.next_step }),
            at: now(),
          });
        }
        return outcome;
      } catch (error) {
        if (error instanceof RateLimitError && error.kind === "rate_limited" && attempt < RATE_LIMIT_RETRIES) {
          pacer.holdOff(Math.min(60, Math.max(1, error.retryAfter ?? 5)) * 1000);
          continue;
        }
        const reason = accountStop(error, keyChoice.from);
        if (reason) {
          stop ??= reason;
          return { email, decision: "error", error: reason.code, message: reason.message };
        }
        return outcomeFromError(email, error);
      }
    }
  };

  let cursor = 0;
  const worker = async () => {
    while (cursor < unique.length) {
      const index = cursor;
      cursor += 1;
      record(offset + index, await checkOne(unique[index] as string));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, worker));
  await cache?.save(warn);
  await log?.flush();

  const done = outcomes.filter((outcome): outcome is Outcome => outcome !== undefined);
  const count = (decision: Decision) => done.filter((outcome) => outcome.decision === decision).length;
  const holds = count("hold");
  const errors = count("error");

  if (!quiet) {
    const lines: string[] = [];
    const fromCache = done.filter((outcome) => outcome.cached).length;
    let summary = `${plural(done.length, "address", "addresses")}: ${count("send")} send, ${holds} hold, ${plural(errors, "error", "errors")}`;
    if (fromCache > 0) summary += ` (${fromCache} from the cache)`;
    summary += ".";
    if (skipped > 0) summary += ` Skipped ${plural(skipped, "line", "lines")} without an @.`;
    lines.push(summary);
    if (stop) lines.push(stop.detail);
    if (!asJson) {
      for (const [footer, countries] of footers) {
        const where = countries.size > 0 ? ` to ${[...countries].sort().join(", ")}` : "";
        lines.push(`Each email you send${where} must meet this: ${footer}`);
      }
    }
    if (notice) lines.push(notice);
    lines.push(...warnings);
    io.stderr(`${lines.join("\n")}\n`);
  }

  if (holds > 0) return EXIT_HOLD;
  if (errors > 0) return EXIT_ERROR;
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// key
// ---------------------------------------------------------------------------

async function postJson(
  fetchImpl: FetchLike,
  url: string,
  body: unknown,
  agent: string,
  timeoutMs: number,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const init: FetchRequestInit = {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": agent },
      body: JSON.stringify(body),
      signal: controller.signal,
    };
    const response = await fetchImpl(url, init);
    const raw = await response.text();
    let data: unknown = null;
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
    return { status: response.status, data: isRecord(data) ? data : {} };
  } catch {
    throw new CliError(
      controller.signal.aborted ? `Precleared did not answer within ${timeoutMs / 1000} seconds.` : "Precleared couldn't be reached.",
    );
  } finally {
    clearTimeout(timer);
  }
}

async function existingKey(path: string): Promise<boolean> {
  try {
    const content = await fs.readFile(path, "utf8");
    return content.split(/\r?\n/).some((line) => line.trim() !== "" && !line.trim().startsWith("#"));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw new CliError(`Could not read ${path}.`);
  }
}

async function keyCommand(args: readonly string[], io: CliIO): Promise<number> {
  const { options, positionals } = parseOptions(args, KEY_SPEC);
  if (options.has("help")) {
    io.stdout(HELP);
    return EXIT_OK;
  }
  if (positionals.length > 0) throw new UsageError("key takes its address with --email.");
  const given = optionText(options, "email");
  if (!given) throw new UsageError("key needs --email: the address the key belongs to.");
  const email = findEmail(given);
  if (!email || given.toLowerCase().replace(/^mailto:/, "") !== email) {
    throw new UsageError(`"${clean(given, 80)}" is not an email address.`);
  }
  const country = countryValue(optionText(options, "country"), "--country");
  const name = optionText(options, "name");
  const company = optionText(options, "company");
  const via = viaValue(optionText(options, "via"));
  const timeoutSeconds = numberValue(optionText(options, "timeout"), "--timeout", 20, 1, 120, false);
  const baseUrl = baseUrlValue(options, io);
  const path = expandHome(optionText(options, "key-file") ?? text(io.env.PRECLEARED_KEY_FILE) ?? join(io.home, KEY_FILE), io.home);

  if (!options.has("force") && (await existingKey(path))) {
    io.stdout(`A key is already saved in ${path}. Kept it. Use --force to replace it.\n`);
    return EXIT_OK;
  }

  const globalFetch = (globalThis as { fetch?: unknown }).fetch;
  const fetchImpl = io.fetch ?? (typeof globalFetch === "function" ? (globalFetch as FetchLike).bind(globalThis) : undefined);
  if (!fetchImpl) throw new CliError("This needs Node 18 or later.");

  const body: Record<string, string> = {
    email,
    use_case: `precleared command line${via ? ` (via ${via})` : ""}: cold-email check before sending`,
  };
  if (country) body.country = country;
  if (name) body.name = name.slice(0, 120);
  if (company) body.company = company.slice(0, 160);

  const { status, data } = await postJson(fetchImpl, `${baseUrl}/api/v1/keys`, body, userAgent(via), timeoutSeconds * 1000);
  if (status === 200 || status === 201) {
    const key = data.key;
    if (typeof key !== "string" || !keyShapeOk(key)) throw new CliError("Precleared's answer had no key in it.");
    try {
      await writePrivate(path, `${key}\n`);
    } catch {
      throw new CliError(`Could not save the key in ${path}. Nothing else was changed.`);
    }
    const perDay = typeof data.free_per_day === "number" && Number.isFinite(data.free_per_day) ? data.free_per_day : 25;
    io.stdout(
      `Saved a free key for ${email} in ${path} (privacy: ${PRIVACY_URL}).\n` +
        `New keys get 100 checks a day for their first 14 days, then ${perDay} a day. precleared check uses it from now on.\n`,
    );
    if (text(io.env.PRECLEARED_API_KEY)) {
      io.stderr(`Note: PRECLEARED_API_KEY is set, and check uses it before ${path}.\n`);
    }
    return EXIT_OK;
  }
  const reason = clean(data.message, 300).replace(/[.\s]+$/, "") || `Precleared answered HTTP ${status}`;
  io.stderr(`precleared: couldn't get a key: ${reason}.\n`);
  if (status === 429) io.stderr(`You can also get one at ${GET_KEY_URL}\n`);
  return EXIT_ERROR;
}
