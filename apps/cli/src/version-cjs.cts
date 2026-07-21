// CommonJS counterpart of version.ts — tshy swaps this in for the CJS build,
// where `require` is native and `import.meta` won't compile.
export const version: string = require("@piplabs/cdr-cli/package.json").version;
