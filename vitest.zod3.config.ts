import { defineConfig, mergeConfig } from "vitest/config";

import base from "./vitest.config";

// Runs the same suite with zod 3.25.76 installed in place of zod 4. The package
// imports "zod/v4", which zod 3.25 and later ship alongside the zod 3 API, so
// the schemas keep working and keep the same types under either major. The
// "zod3" dev dependency is an npm alias for zod@3.25.76. This is how the
// "^3.25.0 || ^4.0.0" peer range is checked.
export default mergeConfig(
  base,
  defineConfig({
    resolve: {
      alias: [
        { find: /^zod$/, replacement: "zod3" },
        { find: /^zod\/(.*)$/, replacement: "zod3/$1" },
      ],
    },
    test: {
      env: { PRECLEARED_ZOD_COMPAT: "v3" },
    },
  }),
);
