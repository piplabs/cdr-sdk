import { Command } from "commander";
import { queryLatestActiveDKGNetwork } from "@piplabs/cdr-sdk";
import { resolveConfig, createClient, output, errExit, type GlobalOptions } from "../utils.js";

/**
 * `cdr-cli status <subcommand>` — read-only DKG / CDR state queries.
 *
 * All subcommands are wallet-free (resolveConfig with requireWallet=false).
 *
 * Subcommands:
 * - `vault <uuid>`     wraps `observer.getVault`
 * - `fees`             wraps `observer.get{Allocate,Write,Read}Fee`
 * - `round`            calls `queryLatestActiveDKGNetwork` directly to surface
 *                      the full DKGNetwork shape (round, stage, total, threshold,
 *                      globalPublicKey, activeValSet, publicCoeffs, …)
 * - `validators`       wraps `observer.getRegisteredValidators`; output is a
 *                      `validatorAddr → commPubKey hex` map
 */
export function statusCommand(program: Command) {
  const status = program.command("status").description("Query DKG / CDR state (read-only, no wallet required)");

  status
    .command("vault <uuid>")
    .description("Get vault details by UUID")
    .action(async (uuidStr: string, _opts: any, cmd: Command) => {
      const cfg = resolveConfig(cmd.optsWithGlobals() as GlobalOptions, /* requireWallet */ false);
      const uuid = parseInt(uuidStr);
      if (!Number.isInteger(uuid) || uuid < 0) {
        errExit(cfg.json, `Invalid uuid: ${uuidStr}. Must be a non-negative integer.`);
      }
      const client = createClient(cfg);
      const vault = await client.observer.getVault(uuid);
      output(vault, cfg.json);
    });

  status
    .command("fees")
    .description("Get current CDR contract fees (allocate / write / read)")
    .action(async (_opts: any, cmd: Command) => {
      const cfg = resolveConfig(cmd.optsWithGlobals() as GlobalOptions, /* requireWallet */ false);
      const client = createClient(cfg);
      const [allocate, write, read] = await Promise.all([
        client.observer.getAllocateFee(),
        client.observer.getWriteFee(),
        client.observer.getReadFee(),
      ]);
      output({ allocateFee: allocate, writeFee: write, readFee: read }, cfg.json);
    });

  status
    .command("round")
    .description("Get full active DKG round state")
    .action(async (_opts: any, cmd: Command) => {
      const cfg = resolveConfig(cmd.optsWithGlobals() as GlobalOptions, /* requireWallet */ false);
      // Skip CDRClient construction: we only need the REST query.
      const network = await queryLatestActiveDKGNetwork({ apiUrl: cfg.apiUrl });
      output(network, cfg.json);
    });

  status
    .command("validators")
    .description("Get validator commPubKeys for the active round")
    .action(async (_opts: any, cmd: Command) => {
      const cfg = resolveConfig(cmd.optsWithGlobals() as GlobalOptions, /* requireWallet */ false);
      const client = createClient(cfg);
      // Returns Map<addr, Uint8Array>; replacer in output() converts both
      // Map → object and Uint8Array → hex automatically.
      const validators = await client.observer.getRegisteredValidators();
      output(validators, cfg.json);
    });
}
