# Changelog

All notable changes to this package are recorded here. The format follows Keep a Changelog, and the package follows semantic versioning.

## 0.2.0 (28 October 2026)

- New: the `precleared` command, for the shell, scripts and pre-send hooks. `precleared check` checks addresses given as arguments or on standard input and exits 0 when every address may be emailed, 2 when at least one must be held (`consent_needed`, `blocked` or `unknown`) and 1 when something could not be checked. That is the contract of cold-cli's `pre_send_checks`. It keeps definite answers for 30 days in a local cache that stores hashes rather than addresses, can write a JSON-lines log, starts at most one check a second, waits and retries after `rate_limited`, and stops with a clear message after a bad key, a 402 or the end of the day's free checks.
- New: `precleared key --email` gets a free key and saves it in `~/.precleared/key`, readable only by you. `check` reads the key from `--key-file`, `PRECLEARED_API_KEY` or that file, and never prints or logs it.
- zod is bundled into the command (English messages only), so it runs with Node alone. The library entries are unchanged and still use your zod.

## 0.1.2 (27 October 2026)

- README only: the allowances section now describes a new key's 14 days at 100 checks a day, the £15 monthly plan that keeps 100 a day, and the £9 starter pack alongside the £39 pack. No code changes.

## 0.1.1 (20 October 2026)

- Fixed: `PreclearedAiSdkTools` and `PreclearedMastraTools` are now type aliases instead of interfaces, so `tools: await preclearedTools(client)` type-checks against `ToolSet` in `ai` 7 (and against index-signature tool records in Mastra) without a cast or a spread. No runtime change.

## 0.1.0 (17 October 2026)

First release.

- `Precleared` client with `check()`, `getReceipt()` (alias `verifyReceipt()`) and `health()`. Zod validation before any request, `address_source` always sent, bearer auth, 20 second timeout, one retry on network errors and 5xx responses.
- Typed errors: `PreclearedError`, `ValidationError`, `AuthError`, `PaymentRequiredError` (`buyUrl`), `RateLimitError` (`kind`, `retryAfter`, `getKeyUrl`), `ReceiptNotFoundError`, `ServerError`, `NetworkError`.
- Result helpers: `isOk`, `mustNotSend`, `needsMoreFacts`, `decidingRule`, `receiptUrl`, `summary`, `summaryText`.
- Framework tools: `precleared/ai-sdk` (Vercel AI SDK), `precleared/mastra` and `precleared/langchain`, each loading its framework only when called.
- `precleared/schemas`: zod schemas and `jsonSchema()` for other agent frameworks; `createToolHandlers()` to run the calls.
- ESM and CommonJS builds with type definitions. Node 18 or later.
