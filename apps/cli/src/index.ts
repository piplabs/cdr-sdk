#!/usr/bin/env node
import { Command } from "commander";
import { statusCommand } from "./commands/status.js";
import { allocateCommand } from "./commands/allocate.js";
import { writeCommand } from "./commands/write.js";
import { readCommand } from "./commands/read.js";
import { encryptCommand } from "./commands/encrypt.js";
import { decryptCommand } from "./commands/decrypt.js";

const program = new Command()
  .name("cdr-cli")
  .description("CLI for interacting with Story L1 CDR system")
  .version("0.1.0")
  .option("--network <network>", "Network (mainnet or testnet)", "testnet")
  .option("--rpc-url <url>", "Override RPC URL")
  .option("--private-key <hex>", "Wallet private key (or CDR_PRIVATE_KEY env)")
  .option("--json", "Output structured JSON", false);

statusCommand(program);
allocateCommand(program);
writeCommand(program);
readCommand(program);
encryptCommand(program);
decryptCommand(program);

program.parse();
