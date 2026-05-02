import { Command } from "commander";
import { toHex, fromHex } from "viem";
import { initWasm } from "@piplabs/cdr-sdk";
import { resolveConfig, createClient, output, parseNonNegInt, type GlobalOptions } from "../utils.js";

/**
 * `cdr-cli access <uuid>` — read + decrypt a CDR vault.
 *
 * Wraps {@link Consumer.accessCDR}. If both `--requester-pub-key` and
 * `--recipient-priv-key` are omitted, the SDK generates an ephemeral
 * keypair internally; if exactly one is supplied, the SDK rejects the
 * combination upfront (InvalidParamsError).
 */
export function accessCommand(program: Command) {
  program
    .command("access <uuid>")
    .description("Read a vault: collect partial decryptions, recover data key")
    .option("--access-aux-data <hex>", "Auxiliary access data", "0x")
    .option("--requester-pub-key <hex>", "Explicit requester public key (uncompressed secp256k1)")
    .option("--recipient-priv-key <hex>", "Explicit recipient private key (must pair with --requester-pub-key)")
    .option("--timeout <ms>", "Partial-collection timeout in ms", "120000")
    .option("--read-fee-override <wei>", "Override read fee (in wei)")
    .action(async (uuidStr: string, opts: any, cmd: Command) => {
      const cfg = resolveConfig(cmd.optsWithGlobals() as GlobalOptions, /* requireWallet */ true);

      const uuid = parseNonNegInt(uuidStr, "uuid", cfg.json);

      await initWasm();
      const client = createClient(cfg);

      // accessCDR doesn't expose pollIntervalMs (it's an internal collectPartials
      // detail with a sane default). Only timeoutMs is surfaced here.
      const timeoutMs = parseNonNegInt(opts.timeout, "timeout", cfg.json);

      const result = await client.consumer.accessCDR({
        uuid,
        accessAuxData: opts.accessAuxData as `0x${string}`,
        requesterPubKey: opts.requesterPubKey as `0x${string}` | undefined,
        recipientPrivKey: opts.recipientPrivKey ? fromHex(opts.recipientPrivKey, "bytes") : undefined,
        timeoutMs,
        feeOverride: opts.readFeeOverride ? BigInt(opts.readFeeOverride) : undefined,
      });

      output(
        {
          dataKey: toHex(result.dataKey),
          txHash: result.txHash,
        },
        cfg.json,
      );
    });
}
