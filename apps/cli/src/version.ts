import { createRequire } from "node:module";

// Self-reference through the package's own `exports` map, so this resolves
// from both `src/` (tsx dev) and `dist/esm/` without a fragile relative path.
// The CJS build swaps in `version-cjs.cts` (tshy dialect polyfill), but still
// type-checks this file — hence the ts-ignore on the ESM-only `import.meta`.
//@ts-ignore
export const version: string = createRequire(import.meta.url)("@piplabs/cdr-cli/package.json").version;
