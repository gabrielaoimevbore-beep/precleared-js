#!/usr/bin/env node
/**
 * The `precleared` executable: wires `main()` in cli.ts to the process.
 * Built on its own into dist/cli.js (see tsup.cli.config.ts), with zod
 * bundled in, so the command runs without the peer dependency installed.
 */

import { homedir } from "node:os";

import { main } from "./cli";

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) process.stderr.write("Type addresses, one per line, then press Ctrl-D.\n");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf8");
}

main(process.argv.slice(2), {
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  readStdin,
  home: homedir(),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`precleared: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
