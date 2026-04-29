#!/usr/bin/env node
import { Command } from "commander";
import { statusCommand } from "./commands/status.js";
import { uploadCommand } from "./commands/upload.js";
import { accessCommand } from "./commands/access.js";

const program = new Command()
  .name("cdr-cli")
  .description("CLI wrapping common SDK operations against a live Story L1 CDR system")
  .version("0.1.2")
  .option("--network <network>", "Network (mainnet or testnet)", "testnet")
  .option("--rpc-url <url>", "EVM RPC URL (or CDR_RPC_URL env; falls back to network default)")
  .option("--api-url <url>", "Story-API REST URL (or CDR_API_URL env, required)")
  .option("--private-key <hex>", "Wallet private key (or CDR_TEST_PRIVATE_KEY env; required for upload/access)")
  .option("--json", "Output structured JSON (errors emit {error:{message,missing?}})", false);

statusCommand(program);
uploadCommand(program);
accessCommand(program);

program.parseAsync().catch((err) => {
  // Action errors (SDK throws, RPC failures, etc.) bubble here. Format
  // for --json mode so scripts can parse; otherwise plain stderr.
  const json = program.opts().json === true;
  const message = err?.message ?? String(err);
  if (json) {
    console.error(JSON.stringify({ error: { message } }));
  } else {
    console.error(`Error: ${message}`);
  }
  process.exit(1);
});
