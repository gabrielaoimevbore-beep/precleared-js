# Changelog

All notable changes to this package are recorded here. The format follows Keep a Changelog, and the package follows semantic versioning.

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
