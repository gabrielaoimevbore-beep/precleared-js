import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import * as root from "../src/index";
import { contactCheckInputSchema } from "../src/schemas";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
  name: string;
  version: string;
  type: string;
  exports: Record<string, unknown>;
  peerDependencies: Record<string, string>;
  peerDependenciesMeta: Record<string, { optional?: boolean }>;
  dependencies?: Record<string, string>;
  files: string[];
  engines: { node: string };
};

const FRAMEWORKS = ['"ai"', "'ai'", "@mastra/core", "@langchain/core"];

function read(file: string): string {
  return readFileSync(join(here, "..", "src", file), "utf8");
}

describe("package shape", () => {
  it("is named precleared at the version the code reports", () => {
    expect(pkg.name).toBe("precleared");
    expect(pkg.version).toBe("0.2.0");
    expect(root.VERSION).toBe(pkg.version);
    expect(root.DEFAULT_USER_AGENT).toBe(`precleared-js/${pkg.version}`);
    expect(pkg.engines.node).toBe(">=18");
    expect(pkg.type).toBe("module");
  });

  it("has no runtime dependencies, zod as a required peer and the frameworks as optional peers", () => {
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(Object.keys(pkg.peerDependencies).sort()).toEqual(["@langchain/core", "@mastra/core", "ai", "zod"]);
    expect(pkg.peerDependenciesMeta.zod).toBeUndefined();
    for (const name of ["ai", "@mastra/core", "@langchain/core"]) {
      expect(pkg.peerDependenciesMeta[name]?.optional).toBe(true);
    }
  });

  it("exposes one entry per helper, each backed by a source file", () => {
    const subpaths = Object.keys(pkg.exports).filter((key) => key !== "./package.json");
    expect(subpaths.sort()).toEqual([".", "./ai-sdk", "./langchain", "./mastra", "./schemas"]);
    const sources = readdirSync(join(here, "..", "src"));
    for (const subpath of subpaths) {
      const file = subpath === "." ? "index.ts" : `${subpath.slice(2)}.ts`;
      expect(sources).toContain(file);
      const entry = pkg.exports[subpath] as { import: { types: string; default: string }; require: { types: string; default: string } };
      expect(entry.import.default).toBe(`./dist/${file.replace(/\.ts$/, ".js")}`);
      expect(entry.import.types).toBe(`./dist/${file.replace(/\.ts$/, ".d.ts")}`);
      expect(entry.require.default).toBe(`./dist/${file.replace(/\.ts$/, ".cjs")}`);
      expect(entry.require.types).toBe(`./dist/${file.replace(/\.ts$/, ".d.cts")}`);
    }
    expect(pkg.files).toContain("dist");
  });

  it("keeps the frameworks out of the main entry", () => {
    // Only the three helper files may mention a framework package, and only
    // through a dynamic import, so importing "precleared" never loads one.
    for (const file of readdirSync(join(here, "..", "src")).filter((name) => name.endsWith(".ts"))) {
      const source = read(file);
      const mentions = FRAMEWORKS.some((needle) => source.includes(needle));
      if (["ai-sdk.ts", "mastra.ts", "langchain.ts"].includes(file)) {
        expect(mentions).toBe(true);
        expect(source).toMatch(/import\((["'])(ai|@mastra\/core\/tools|@langchain\/core\/tools)\1\)/);
        expect(source).not.toMatch(/^import (?!type )[^;]*from (["'])(ai|@mastra\/core\/tools|@langchain\/core\/tools)\1/m);
      } else {
        expect(mentions, `${file} must not reference a framework package`).toBe(false);
      }
    }
    const index = read("index.ts");
    for (const helper of ["./ai-sdk", "./mastra", "./langchain"]) {
      expect(index).not.toContain(`"${helper}"`);
    }
  });

  it("exports the documented surface from the main entry", () => {
    for (const name of [
      "Precleared",
      "PreclearedError",
      "ValidationError",
      "AuthError",
      "PaymentRequiredError",
      "RateLimitError",
      "ReceiptNotFoundError",
      "ServerError",
      "NetworkError",
      "MissingDependencyError",
      "isPreclearedError",
      "createToolHandlers",
      "summary",
      "summaryText",
      "receiptUrl",
      "isOk",
      "mustNotSend",
      "ADDRESS_SOURCES",
      "VERDICTS",
      "DEFAULT_BASE_URL",
      "DEFAULT_TIMEOUT_MS",
      "CHECK_DESCRIPTION",
      "VERIFY_DESCRIPTION",
    ]) {
      expect(root, name).toHaveProperty(name);
    }
    expect(root.ADDRESS_SOURCES).toEqual(["published", "bought", "scraped", "given", "unknown"]);
    expect(root.VERDICTS).toEqual(["ok_to_email", "consent_needed", "blocked", "unknown"]);
    expect(root.DEFAULT_BASE_URL).toBe("https://precleared.dev");
    for (const cls of [
      root.ValidationError,
      root.AuthError,
      root.PaymentRequiredError,
      root.RateLimitError,
      root.ReceiptNotFoundError,
      root.ServerError,
      root.NetworkError,
    ]) {
      expect(Object.getPrototypeOf(cls)).toBe(root.PreclearedError);
    }
  });

  it("runs against the zod install the config says", () => {
    // The compat run swaps in zod 3.25.76 (dev alias "zod3"); the default run
    // uses zod 4. The two majors word a type error differently at the root
    // import, which proves the swap took. The package itself always imports
    // "zod/v4", so its schemas are zod 4 schemas in both runs.
    const message = z.string().safeParse(1).error?.issues[0]?.message ?? "";
    if (process.env.PRECLEARED_ZOD_COMPAT === "v3") {
      expect(message).toBe("Expected string, received number");
    } else {
      expect(message).toBe("Invalid input: expected string, received number");
    }
    expect("_zod" in contactCheckInputSchema).toBe(true);
    for (const file of ["schemas.ts", "mastra.ts"]) {
      expect(read(file)).toContain('from "zod/v4"');
      expect(read(file)).not.toMatch(/from "zod"/);
    }
  });
});
