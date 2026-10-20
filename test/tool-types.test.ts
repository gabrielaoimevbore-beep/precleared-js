import { describe, expect, it } from "vitest";
import type { PreclearedAiSdkTools } from "../src/ai-sdk";
import type { PreclearedMastraTools } from "../src/mastra";

// Compile-time guard: frameworks type their tool sets as index-signature records
// (ai 7's ToolSet is Record<string, Tool>). An interface is not assignable to one,
// so these lines stop compiling if either type goes back to being an interface.
const aiSdkAsRecord = (tools: PreclearedAiSdkTools): Record<string, unknown> => tools;
const mastraAsRecord = (tools: PreclearedMastraTools): Record<string, unknown> => tools;

describe("tool set types", () => {
  it("are assignable to index-signature records", () => {
    expect(typeof aiSdkAsRecord).toBe("function");
    expect(typeof mastraAsRecord).toBe("function");
  });
});
