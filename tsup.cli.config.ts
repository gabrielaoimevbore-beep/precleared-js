import { join } from "node:path";

import { defineConfig } from "tsup";

// The `precleared` command (dist/cli.js), built after the library (tsup.config.ts)
// and kept apart from it: Node only, ESM only, no type definitions. zod is
// bundled in, so `npm install -g precleared` or `npx precleared` works even
// where the peer dependency isn't installed. The library entries still import
// zod from the user's install, as before. The shebang comes from src/bin.ts.

// zod re-exports its 60-odd translations as `z.locales`, and that pulls them
// all into a bundle. The command only needs English (which zod loads directly,
// not through this index), so the index is swapped for one that has just `en`.
const englishOnly = {
  name: "zod-english-only",
  setup(build: {
    onResolve(options: { filter: RegExp }, callback: (args: { path: string; resolveDir: string }) => unknown): void;
    onLoad(options: { filter: RegExp; namespace: string }, callback: (args: { pluginData: { dir: string } }) => unknown): void;
  }) {
    build.onResolve({ filter: /^\.\.\/locales\/index\.js$/ }, (args) => {
      if (!/[\\/]zod[\\/]v4[\\/](classic|core)$/.test(args.resolveDir)) return undefined;
      return { path: "zod-locales-en", namespace: "zod-english-only", pluginData: { dir: join(args.resolveDir, "..", "locales") } };
    });
    build.onLoad({ filter: /.*/, namespace: "zod-english-only" }, (args) => ({
      contents: 'export { default as en } from "./en.js";\n',
      resolveDir: args.pluginData.dir,
      loader: "js",
    }));
  },
};

export default defineConfig({
  entry: { cli: "src/bin.ts" },
  format: ["esm"],
  platform: "node",
  target: "node18",
  dts: false,
  sourcemap: false,
  splitting: false,
  clean: false,
  noExternal: [/^zod(\/.*)?$/],
  esbuildPlugins: [englishOnly],
});
