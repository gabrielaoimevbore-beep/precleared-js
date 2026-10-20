import { describe, expect, it, vi } from "vitest";

import { preclearedTools as aiTools } from "../src/ai-sdk";
import { MissingDependencyError } from "../src/index";
import { preclearedTools as langchainTools } from "../src/langchain";
import { preclearedTools as mastraTools } from "../src/mastra";

import { makeClient } from "./helpers";

// Each factory fails the way Node does when the package is not installed.
vi.mock("ai", () => {
  throw Object.assign(new Error("Cannot find package 'ai'"), { code: "ERR_MODULE_NOT_FOUND" });
});
vi.mock("@mastra/core/tools", () => {
  throw Object.assign(new Error("Cannot find package '@mastra/core'"), { code: "ERR_MODULE_NOT_FOUND" });
});
vi.mock("@langchain/core/tools", () => {
  throw Object.assign(new Error("Cannot find package '@langchain/core'"), { code: "ERR_MODULE_NOT_FOUND" });
});

describe("missing peer dependencies", () => {
  it("each helper imports without its framework and explains what to install when called", async () => {
    const { client, mock } = makeClient();

    const cases: Array<[() => Promise<unknown>, string, string]> = [
      [() => aiTools(client), "precleared/ai-sdk", "npm install ai"],
      [() => mastraTools(client), "precleared/mastra", "npm install @mastra/core"],
      [() => langchainTools(client), "precleared/langchain", "npm install @langchain/core"],
    ];
    for (const [run, entry, hint] of cases) {
      const error = await run().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MissingDependencyError);
      const typed = error as MissingDependencyError;
      expect(typed.message).toContain(entry);
      expect(typed.message).toContain(hint);
      expect(typed.code).toBe("ERR_PRECLEARED_MISSING_DEPENDENCY");
      // vitest wraps a throwing factory in its own error; the original is its cause.
      const chain: string[] = [];
      for (let cause = typed.cause as Error | undefined; cause; cause = cause.cause as Error | undefined) chain.push(cause.message);
      expect(chain.some((message) => message.startsWith("Cannot find package"))).toBe(true);
    }
    expect(mock.requests).toEqual([]);
  });
});
