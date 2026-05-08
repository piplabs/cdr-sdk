import { Command } from "commander";
import { toHex } from "viem";
import { initWasm } from "@piplabs/cdr-sdk";
import { resolveConfig, createClient, output, type GlobalOptions } from "../utils.js";

/**
 * `cdr-cli upload` — bootstrap a new CDR vault.
 *
 * The CLI generates a fresh 32-byte random data key internally (no
 * `--data-key` flag — keeping the surface as a smoke/demo tool). The
 * generated dataKey is included in the output so the caller can later
 * verify the round-trip via `cdr-cli access <uuid>`.
 *
 * Wraps {@link Uploader.uploadCDR}. globalPubKey is auto-queried via the
 * Observer (SDK's optional-globalPubKey path).
 */
export function uploadCommand(program: Command) {
  program
    .command("upload")
    .description("Upload a new CDR vault (generates a random data key, encrypts via DKG, writes on-chain)")
    .requiredOption("--write-condition <addr>", "Write condition contract address")
    .requiredOption("--read-condition <addr>", "Read condition contract address")
    .option("--write-condition-data <hex>", "Write condition data", "0x")
    .option("--read-condition-data <hex>", "Read condition data", "0x")
    .option("--access-aux-data <hex>", "Auxiliary access data", "0x")
    .option("--updatable", "Allow vault data to be updated", false)
    .option("--allocate-fee-override <wei>", "Override allocate fee (in wei)")
    .option("--write-fee-override <wei>", "Override write fee (in wei)")
    .action(async (opts: any, cmd: Command) => {
      const cfg = resolveConfig(cmd.optsWithGlobals() as GlobalOptions, /* requireWallet */ true);
      await initWasm();
      const client = createClient(cfg);

      const dataKey = crypto.getRandomValues(new Uint8Array(32));
      const result = await client.uploader.uploadCDR({
        dataKey,
        updatable: opts.updatable,
        writeConditionAddr: opts.writeCondition as `0x${string}`,
        readConditionAddr: opts.readCondition as `0x${string}`,
        writeConditionData: opts.writeConditionData as `0x${string}`,
        readConditionData: opts.readConditionData as `0x${string}`,
        accessAuxData: opts.accessAuxData as `0x${string}`,
        allocateFeeOverride: opts.allocateFeeOverride ? BigInt(opts.allocateFeeOverride) : undefined,
        writeFeeOverride: opts.writeFeeOverride ? BigInt(opts.writeFeeOverride) : undefined,
      });

      output(
        {
          uuid: result.uuid,
          dataKey: toHex(dataKey),
          txHashes: result.txHashes,
        },
        cfg.json,
      );
    });
}
