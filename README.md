# precleared

TypeScript and JavaScript client for [Precleared](https://precleared.dev), a cold-email legality check for AI agents.

One call per recipient, before the first cold email, answers one question: is it legal to send this person a cold or marketing email? Precleared looks the recipient up live (for the UK: Companies House, the domain and the company website) and applies the local rules. It returns a verdict, the rule that decided it with its source, what the footer must include, the next step and a signed receipt.

It covers eight countries: the UK (PECR and UK GDPR), the US (CAN-SPAM), Canada (CASL), Germany (UWG), France (CPCE and CNIL guidance), Australia (Spam Act 2003), Ireland (S.I. 336/2011) and the Netherlands (Telecommunicatiewet).

Decision support with sources, not legal advice.

## Install

```bash
npm install precleared zod
```

Node 18 or later. The package ships ESM and CommonJS builds with type definitions. `zod` is a peer dependency: 3.25 or later, or 4. The package imports `zod/v4`, which both ship, so the schemas and their types are the same under either major. The framework packages below are optional peers: install the one you use (`ai` 5 or later, `@mastra/core` 0.20 or later, `@langchain/core` 0.3.60 or later).

The `precleared` command needs only Node: see [Command line](#command-line).

## Quick start

```ts
import { Precleared } from "precleared";

const client = new Precleared({ apiKey: process.env.PRECLEARED_API_KEY }); // or new Precleared() for keyless use
const result = await client.check({ recipient_email: "jane@acme.co.uk", pitch: "Bookkeeping software for small firms", address_source: "unknown" });
if (result.verdict === "ok_to_email") send(result.footer_text); else console.log(result.verdict, result.next_step);
```

`check()` takes the same fields as the API: `recipient_email` or `recipient_domain`, `pitch`, `address_source` (`published`, `bought`, `scraped`, `given` or `unknown`), `sender_country` (default `GB`), `existing_customer`, `pitch_relevant`, `company_number`, `recipient_country`, `default_recipient_country` and `suppressed`.

`address_source` defaults to `unknown` and is always sent (the API treats a missing value as `unknown` too). It changes verdicts, so never pass `published` unless the recipient put the address on their website or a public listing for people to contact them.

Every call is validated with zod before anything is sent. Strings are trimmed, country codes are upper-cased and `address_source` is lower-cased. `null`, `undefined` and blank strings count as not given. Unknown fields are forwarded to the API as they are, for request fields newer than this client.

### Reading a result

| Verdict | Meaning | `isOk(result)` | `mustNotSend(result)` |
| --- | --- | --- | --- |
| `ok_to_email` | Send, with a footer that meets `footer_text` | `true` | `false` |
| `consent_needed` | Do not send. Follow `next_step` | `false` | `true` |
| `blocked` | Do not send. Follow `next_step` | `false` | `true` |
| `unknown` | A fact could not be established. Treat as `consent_needed` unless you can supply the missing fact (for example `company_number` or `recipient_country`) and check again | `false` | `false` (see `needsMoreFacts`) |

`footer_text` describes a requirement (who you are, a postal address, a way to opt out). It is not wording to paste.

`CheckResult` has the API's fields with their API names: `verdict`, `confidence`, `reasons[]` (each with `rule_key`, `text`, `source_title`, `source_url`, or a `note`), `rules_applied`, `footer_text`, `next_step`, `facts`, `receipt` (`id`, `created_at`, `request_hash`, `response_hash`, `signature`, `algorithm`, `key_version`, `verify_url`), `usage` (`free_remaining_today`, `credits_remaining`), `disclaimer` and `rules_version`. Fields the API adds later are kept on the object.

Helpers, all exported from `precleared`:

- `isOk(result)`, `mustNotSend(result)`, `needsMoreFacts(result)`
- `decidingRule(result)` and `decidingReason(result)`: the rule that decided the verdict, and its reason with the source
- `notes(result)`: the other `reasons` entries
- `receiptUrl(result)`: the receipt page, `https://precleared.dev/r/<id>`
- `summary(result)` and `summaryText(result)`: the compact forms the framework tools return

### Receipts and health

```ts
const receipt = await client.getReceipt("cc_rcpt_..."); // also accepts a receipt URL; verifyReceipt() is an alias
receipt.verdict, receipt.request_hash, receipt.response_hash, receipt.signature, receipt.public_key;

const health = await client.health(); // GET /api/v1/health: status, checked_at, api_ok, mcp_ok, worker_ok
```

A receipt proves what was asked and answered. The signature is Ed25519 over `request_hash.response_hash`; the receipt endpoint returns the public key alongside it, and `GET /api/v1/public-key` serves it too.

## Command line

The package includes a `precleared` command for the shell, scripts and the pre-send hooks of cold-email tools. It needs Node 18 or later and nothing else: zod is built into it.

```bash
npm install -g precleared
precleared key --email you@yourcompany.com        # optional: a free key, saved in ~/.precleared/key
precleared check jane@acme.co.uk sam@example.com
precleared check --stdin --sender-country US < leads.txt
```

Each address gets one line: `send`, `hold` or `error`, with the verdict, the rule that decided it and the next step. `--json` prints a JSON object per address instead.

| Exit code | Meaning |
| --- | --- |
| `0` | Every address may be emailed (`ok_to_email`) |
| `2` | At least one address must be held: `consent_needed`, `blocked` or `unknown` |
| `1` | Something could not be checked: a network problem, a bad key, the day's free checks used up, or a mistake in the command |

A hold wins over an error, so a hook that stops on `2` never sends to a held address. Treat `1` as "don't send yet".

- `--stdin` reads addresses from standard input, one per line. Lines without an `@` (phone numbers, blank lines, `#` notes) are skipped. `Name <address>` and the first column of a CSV work too. Each address is checked once.
- `--sender-country` (`GB`, `US` or `AE`, default `GB`), `--address-source` (default `unknown`), `--pitch`, `--recipient-country` and `--default-country` are the fields `check()` takes. `PRECLEARED_SENDER_COUNTRY`, `PRECLEARED_ADDRESS_SOURCE` and `PRECLEARED_PITCH` set defaults.
- `--log FILE` (or `PRECLEARED_LOG`) adds a JSON line per address: the decision, verdict, rule, next step, footer requirement and receipt id. Hooks usually throw the output away, so this is where to look later.
- Definite answers are kept for 30 days in `~/.precleared/cache.json`, so a follow-up to the same person doesn't spend another check. The file holds hashes, not addresses, and `unknown` is never kept. `--cache-days N` changes the 30 days; `--no-cache` turns it off.
- Checks run four at a time (`--concurrency`) and start at most once a second, inside the limit of 60 a minute. After a `rate_limited` answer the command waits and tries again. After a bad key, a 402 or the end of the day's free checks it stops and says what to do.
- `--timeout SECONDS` (default 30) per check, `--quiet` for the exit code alone, and `--via NAME` to name the tool running the command, for example `cold-cli`.

The key comes from `--key-file`, then `PRECLEARED_API_KEY`, then `~/.precleared/key`, and is never printed or logged. Without one the keyless allowance applies: 10 checks a day per network. `precleared key --email you@yourcompany.com` gets a free key (100 checks a day for the first 14 days, then 25 a day) and saves it in a file only you can read. Precleared receives the address to make the key (privacy: https://precleared.dev/privacy).

### In cold-cli

[cold-cli](https://github.com/andersmyrmel/cold-cli) runs a pre-send check before every delivery, follow-ups and inbox replies included. It passes the recipients on standard input and reads only the exit code: `0` sends, `2` skips the lead's remaining steps, anything else blocks that delivery. That is the contract `precleared check` follows.

1. Install the command and get a key: `npm install -g precleared`, then `precleared key --email you@yourcompany.com`.
2. Find the full paths with `which node` and `which precleared`. cold-cli runs the command directly, often from cron, so it may not find either by name.
3. Add the check to `~/.cold-cli/config.yml`, with your two paths, your workspace and your sender country:

```yaml
pre_send_checks:
  your-workspace:
    command: ["/usr/local/bin/node", "/usr/local/bin/precleared", "check", "--stdin", "--sender-country", "GB", "--via", "cold-cli", "--log", "~/.precleared/cold-cli.log"]
    timeout_seconds: 90
```

A check usually takes a few seconds but can take up to 25 when a company register is slow, so the timeout leaves room for one retry. The command expands the `~` itself. When a lead is held, `~/.precleared/cold-cli.log` says why.

Any other tool that runs a command before sending and reads its exit code can use it the same way.

## Framework tools

Each helper exposes the same two tools, `contact_check` and `verify_receipt`, with descriptions that tell the model when to call them: before the first cold email to anyone who is not already a customer, in the UK, US, Canada, Germany, France, Australia, Ireland or the Netherlands, and not for transactional email. The tools return compact text (verdict, rule, footer_text, next_step, receipt URL) rather than the whole JSON. Pass `{ format: "json" }` for objects instead.

Each helper lives in its own entry point and loads its framework only when you call it, so the main `precleared` import never depends on a framework. The factories are `async` for that reason.

Example tool output:

```
verdict: consent_needed (confidence: medium)
rule: gb_individual_consent
reason: The recipient is a sole trader or a partnership in England, Wales or Northern Ireland. PECR treats them as individual subscribers, so unsolicited marketing email needs their prior consent, or the soft opt-in for existing customers. Source: PECR 2003 regulation 22(2) and ICO Guide to PECR, https://www.legislation.gov.uk/uksi/2003/2426/regulation/22
next_step: Do not cold email. Use a route they offer, such as their contact form, or obtain consent first.
receipt: cc_rcpt_E21TTJV8D9JAYTQZ https://precleared.dev/r/cc_rcpt_E21TTJV8D9JAYTQZ
```

API errors come back as text too (`error: daily_limit`, with `get_key_url`, `buy_url` or `retry_after` when the API gives one), so the agent can react instead of crashing.

### Vercel AI SDK

```ts
import { generateText } from "ai"; // npm install ai (version 5 or later)
import { Precleared } from "precleared";
import { preclearedTools } from "precleared/ai-sdk";

const client = new Precleared({ apiKey: process.env.PRECLEARED_API_KEY });
const { text } = await generateText({
  model,
  tools: await preclearedTools(client),
  prompt: "Can I cold email jane@acme.co.uk about our bookkeeping software? The address was on their website.",
});
```

`preclearedTools()` returns `{ contact_check, verify_receipt }` built with `tool()`, with zod input schemas, so they work with `generateText`, `streamText` and `ToolLoopAgent`.

### Mastra

```ts
import { Agent } from "@mastra/core/agent"; // npm install @mastra/core
import { Precleared } from "precleared";
import { preclearedTools } from "precleared/mastra";

const client = new Precleared({ apiKey: process.env.PRECLEARED_API_KEY });
export const sdr = new Agent({
  name: "SDR",
  instructions: "Check every address before the first email.",
  model,
  tools: await preclearedTools(client),
});
```

The tools are built with `createTool()` and have `inputSchema` and `outputSchema`. Both Mastra 1.x (`execute(inputData, context)`) and 0.x (`execute({ context })`) are supported.

### LangChain and LangGraph

```ts
import { createAgent } from "langchain"; // npm install langchain @langchain/core
import { Precleared } from "precleared";
import { preclearedTools } from "precleared/langchain";

const client = new Precleared({ apiKey: process.env.PRECLEARED_API_KEY });
const agent = createAgent({ model, tools: await preclearedTools(client) });
```

`preclearedTools()` returns `[contact_check, verify_receipt]` as `DynamicStructuredTool`s, so they also work with `model.bindTools(...)` and LangGraph's prebuilt agents.

### Any other agent

`precleared/schemas` exports the zod schemas (`contactCheckInputSchema`, `verifyReceiptInputSchema`) and `jsonSchema()`, which returns the two tools as plain JSON Schema with their names and descriptions. `createToolHandlers()` runs the calls.

```ts
import { Precleared, createToolHandlers } from "precleared";
import { jsonSchema } from "precleared/schemas";

const client = new Precleared({ apiKey: process.env.PRECLEARED_API_KEY });
const definitions = jsonSchema(); // { contact_check: { name, description, parameters }, verify_receipt: { ... } }
const handlers = createToolHandlers(client);

// When the model calls a tool:
const output = await handlers[toolCall.name](toolCall.arguments); // compact text for the model
```

`createToolHandlers()` accepts booleans sent as strings (`"true"`, `"no"`) and blank strings, which models sometimes produce. It never throws for an API error; it returns the error as text (or an object with `{ format: "json" }`).

## Errors

Every error the client throws is a subclass of `PreclearedError`, with `message`, `status` (HTTP status, or `undefined` when no response arrived), `code` (the API's short code) and `body` (the parsed JSON error body). Bad arguments throw `ValidationError` before anything is sent, with `code` `invalid_arguments` and field-level `issues`.

| Class | When | Extra fields |
| --- | --- | --- |
| `ValidationError` | A malformed argument (before any request), or 400 from the API (the message names the field) | `issues` |
| `AuthError` | 401, `invalid_key` or `revoked_key` | `code` |
| `PaymentRequiredError` | 402, free checks used and no pack credits | `buyUrl` |
| `RateLimitError` | 429. `kind` is `daily_limit` (free daily allowance used) or `rate_limited` (more than 60 checks a minute) | `kind`, `retryAfter` (seconds, from the body or the `Retry-After` header), `getKeyUrl` |
| `ReceiptNotFoundError` | 404 from the receipt endpoint | |
| `ServerError` | 5xx, after one retry | |
| `NetworkError` | The request did not complete. `code` is `timeout` or `network_error` | `cause` is the underlying error |

```ts
import { Precleared, RateLimitError, PaymentRequiredError } from "precleared";

try {
  const result = await new Precleared().check({ recipient_email: "jane@acme.co.uk" });
} catch (error) {
  if (error instanceof RateLimitError && error.kind === "daily_limit") console.log("Get a free key:", error.getKeyUrl);
  else if (error instanceof RateLimitError) await sleep((error.retryAfter ?? 1) * 1000);
  else if (error instanceof PaymentRequiredError) console.log("Buy a pack:", error.buyUrl);
  else throw error;
}
```

The API key is never logged, printed, serialised or included in an error.

## Timeouts and retries

Each request has a 20 second timeout (`timeoutMs`). A check can take up to 25 seconds when a register or website is slow, so raise it if you see timeouts. The client retries once after a network error, a timeout or a 5xx response, with a short pause (`retryDelayMs`, 300 ms). It never retries a 4xx. Pass `{ signal }` to `check()` or `getReceipt()` to cancel a request; your abort reason is thrown as it is and is not retried.

## Allowances and limits

- Without a key: 10 checks a day over the REST API, shared by everyone on the same network, and 100 a day over MCP. No sign-in needed.
- With a free key (https://precleared.dev/get-key, no card): 100 checks a day for the first 14 days, then 25 a day over the REST API and 100 over MCP.
- 60 checks a minute per key. Above that the API returns 429 `rate_limited` with `retry_after`.
- Days run on UK time. For more, £15 a month keeps 100 checks a day, or buy a pack: £9 for 300 checks (a key's first purchase) or £39 for 2,000. Pack checks are used after the day's free checks, never expire and stack on the same key. When no credits are left the API returns 402 with `buy_url`.

## Configuration

```ts
new Precleared({
  apiKey: undefined,                    // pc_live_... key, or the PRECLEARED_API_KEY environment variable. null forces keyless use.
  baseUrl: "https://precleared.dev",
  timeoutMs: 20000,                     // per attempt
  retries: 1,                           // after a network error, a timeout or a 5xx; never after a 4xx
  retryDelayMs: 300,
  fetch: globalThis.fetch,              // any fetch-compatible function
  userAgent: "precleared-js/<version>", // Precleared's hosting refuses requests without one
});
```

The client works anywhere `fetch` and `AbortController` exist: Node 18 or later, Bun, Deno, Cloudflare Workers, Vercel Edge and browsers. Browsers do not let a page set `User-Agent`; that is fine.

## Disclaimer

Decision support with sources, not legal advice. The receipt proves what was asked and answered, not that an email was sent.

## Support

support@precleared.dev. API reference: https://precleared.dev/docs and https://precleared.dev/openapi.json. Python SDK: `pip install precleared`.

## Development

```bash
npm install
npm test               # vitest, with zod 4 installed
npm run test:zod3      # the same suite with zod 3.25 swapped in (the "zod3" dev alias)
npm run typecheck
npm run build          # tsup: dist/ with ESM, CommonJS and types, then the command (dist/cli.js)
npm run smoke          # loads dist/ as ESM and CommonJS, runs the command, all against a local server
```

The tests stub `fetch` and never call the live API. The framework tests stub `ai`, `@mastra/core/tools` and `@langchain/core/tools` with `vi.mock`, so they run without the frameworks installed.
