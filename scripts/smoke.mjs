// Smoke test for the built package: loads dist/ as ESM and as CommonJS, and
// runs real requests with Node's own fetch against a local HTTP server.
// Nothing leaves the machine. Run after `npm run build`: `npm run smoke`.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);

const esm = await import("../dist/index.js");
const cjs = require("../dist/index.cjs");
const esmSchemas = await import("../dist/schemas.js");
const cjsSchemas = require("../dist/schemas.cjs");

const OK = {
  verdict: "ok_to_email",
  confidence: "high",
  reasons: [{ rule_key: "us_canspam_ok", text: "t", source_title: "s", source_url: "u" }],
  rules_applied: ["us_canspam_ok"],
  footer_text: "footer",
  next_step: "Send.",
  facts: {},
  receipt: { id: "cc_rcpt_SMOKE000000000001" },
  usage: { free_remaining_today: 9, credits_remaining: 0 },
  disclaimer: "Decision support with sources, not legal advice.",
};

const seen = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });
    if (req.url === "/api/v1/check") {
      if (seen.filter((r) => r.url === "/api/v1/check").length === 1) {
        res.writeHead(503, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "server_error", message: "first call fails" }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(OK));
    }
    if (req.url === "/api/v1/slow") {
      return; // never answers: exercises the timeout
    }
    if (req.url?.startsWith("/api/v1/receipt")) {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "not_found", message: "No receipt has that id." }));
    }
    res.writeHead(429, { "content-type": "application/json", "retry-after": "3" });
    res.end(JSON.stringify({ error: "rate_limited" }));
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

// A second server for the command: answers by the recipient's local part.
const CONSENT = { ...OK, verdict: "consent_needed", rules_applied: ["gb_individual_consent"], footer_text: null, next_step: "Do not cold email." };
const cliSeen = [];
const cliServer = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    cliSeen.push({ url: req.url, headers: req.headers, body });
    const email = JSON.parse(body || "{}").recipient_email ?? "";
    if (email.startsWith("fail@")) {
      res.writeHead(500, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "server_error", message: "fails on purpose" }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(email.startsWith("consent@") ? CONSENT : OK));
  });
});
await new Promise((resolve) => cliServer.listen(0, "127.0.0.1", resolve));
const cliBaseUrl = `http://127.0.0.1:${cliServer.address().port}`;

try {
  for (const [label, mod] of [
    ["esm", esm],
    ["cjs", cjs],
  ]) {
    seen.length = 0;
    const client = new mod.Precleared({ apiKey: "pc_live_smoke", baseUrl, retryDelayMs: 0, timeoutMs: 2000 });
    const result = await client.check({ recipient_email: "jane@acme.co.uk", pitch: "Bookkeeping" });
    assert.equal(result.verdict, "ok_to_email", `${label}: verdict`);
    assert.equal(seen.length, 2, `${label}: one retry after the 503`);
    assert.equal(seen[1].headers.authorization, "Bearer pc_live_smoke", `${label}: bearer header`);
    assert.equal(seen[1].headers["user-agent"], `precleared-js/${mod.VERSION}`, `${label}: user agent`);
    assert.equal(seen[1].headers["content-type"], "application/json", `${label}: content type`);
    assert.deepEqual(JSON.parse(seen[1].body), {
      recipient_email: "jane@acme.co.uk",
      sender_country: "GB",
      address_source: "unknown",
      existing_customer: false,
      pitch: "Bookkeeping",
    });
    assert.equal(mod.receiptUrl(result, client.baseUrl), `${baseUrl}/r/cc_rcpt_SMOKE000000000001`);
    assert.match(mod.summaryText(result), /^verdict: ok_to_email \(confidence: high\)/);

    await assert.rejects(client.getReceipt("cc_rcpt_MISSING"), mod.ReceiptNotFoundError, `${label}: 404 maps`);
    await assert.rejects(client.health(), (error) => error instanceof mod.RateLimitError && error.retryAfter === 3, `${label}: 429 maps`);
    await assert.rejects(client.check({}), mod.ValidationError, `${label}: validation`);

    const slow = new mod.Precleared({ baseUrl, retries: 0, timeoutMs: 300, fetch: (url, init) => fetch(`${baseUrl}/api/v1/slow`, init) });
    const started = Date.now();
    await assert.rejects(slow.check({ recipient_email: "jane@acme.co.uk" }), (error) => error instanceof mod.NetworkError && error.code === "timeout", `${label}: timeout`);
    assert.ok(Date.now() - started < 2000, `${label}: timeout fired promptly`);

    const handlers = mod.createToolHandlers(client);
    const text = await handlers.contact_check({ recipient_email: "jane@acme.co.uk", existing_customer: "false" });
    assert.match(text, /^verdict: ok_to_email/, `${label}: tool handler`);

    console.log(`${label}: core client OK`);
  }

  for (const [label, schemas] of [
    ["esm", esmSchemas],
    ["cjs", cjsSchemas],
  ]) {
    const schema = schemas.jsonSchema();
    assert.equal(schema.contact_check.name, "contact_check");
    assert.equal(Object.keys(schema.contact_check.parameters.properties).length, 10);
    assert.ok(schemas.contactCheckInputSchema.safeParse({ recipient_email: "a@b.co" }).success);
    console.log(`${label}: schemas OK`);
  }

  // The helpers import without their frameworks and fail clearly when called.
  for (const [entry, importer] of [
    ["ai-sdk", () => import("../dist/ai-sdk.js")],
    ["mastra", () => import("../dist/mastra.js")],
    ["langchain", () => import("../dist/langchain.js")],
    ["ai-sdk (cjs)", async () => require("../dist/ai-sdk.cjs")],
    ["mastra (cjs)", async () => require("../dist/mastra.cjs")],
    ["langchain (cjs)", async () => require("../dist/langchain.cjs")],
  ]) {
    const helper = await importer();
    const client = new esm.Precleared({ baseUrl });
    await assert.rejects(helper.preclearedTools(client), (error) => error.name === "MissingDependencyError" && /npm install/.test(error.message), `${entry}: missing peer message`);
    console.log(`${entry}: helper loads without its framework and explains the install`);
  }

  // One copy of the error classes across entries (shared chunks).
  const { preclearedTools } = await import("../dist/ai-sdk.js");
  assert.equal(typeof preclearedTools, "function");
  assert.equal(esm.PreclearedError, (await import("../dist/index.js")).PreclearedError);

  // The command: dist/cli.js copied out of the project, so it can only work
  // if zod really is bundled into it, run by Node against a local server.
  const cliDir = mkdtempSync(join(tmpdir(), "precleared-smoke-"));
  copyFileSync(new URL("../dist/cli.js", import.meta.url), join(cliDir, "cli.mjs"));
  assert.match(readFileSync(join(cliDir, "cli.mjs"), "utf8"), /^#!\/usr\/bin\/env node\n/, "cli: shebang");
  const runCli = (args, input = "") =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(cliDir, "cli.mjs"), ...args], {
        cwd: cliDir,
        env: { ...process.env, HOME: cliDir, USERPROFILE: cliDir, PRECLEARED_API_KEY: "", PRECLEARED_KEY_FILE: "" },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(input);
    });
  const hook = ["check", "--stdin", "--no-cache", "--base-url", cliBaseUrl, "--timeout", "5"];
  let run = await runCli(["--version"]);
  assert.equal(run.stdout.trim(), esm.VERSION, "cli: version");
  run = await runCli(hook, "ok@acme.co.uk\n+447700900123\n");
  assert.equal(run.code, 0, `cli: send exits 0 (${run.stderr})`);
  assert.match(run.stdout, /^send {3}ok@acme\.co\.uk {2}ok_to_email/, "cli: send line");
  run = await runCli(hook, "ok@acme.co.uk\nconsent@acme.co.uk\n");
  assert.equal(run.code, 2, "cli: a hold exits 2");
  run = await runCli(hook, "fail@acme.co.uk\n");
  assert.equal(run.code, 1, "cli: an error exits 1");
  run = await runCli(["check"]);
  assert.equal(run.code, 1, "cli: no addresses exits 1");
  assert.equal(cliSeen.at(-1)?.headers["user-agent"], `precleared-cli/${esm.VERSION} (+https://www.npmjs.com/package/precleared)`, "cli: user agent");
  console.log("cli: runs on its own, exit codes 0, 2 and 1");

  console.log("smoke: all good");
} finally {
  server.closeAllConnections?.();
  server.close();
  cliServer.closeAllConnections?.();
  cliServer.close();
}
