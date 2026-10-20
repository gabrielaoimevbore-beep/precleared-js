import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "ai-sdk": "src/ai-sdk.ts",
    mastra: "src/mastra.ts",
    langchain: "src/langchain.ts",
    schemas: "src/schemas.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  // Shared chunks for both formats, so every entry uses one copy of the client,
  // the error classes and the schemas (instanceof checks depend on that).
  splitting: true,
  target: "node18",
  platform: "neutral",
  // Peer dependencies stay external. tsup does this from package.json already;
  // listing them keeps the intent visible.
  external: ["zod", "ai", "@mastra/core", "@langchain/core"],
});
