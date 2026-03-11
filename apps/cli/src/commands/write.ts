import { Command } from "commander";
import { createClient, output, type GlobalOptions } from "../utils.js";

export function writeCommand(program: Command) {
  program
    .command("write")
    .description("Write encrypted data to a CDR vault")
    .requiredOption("--uuid <number>", "Vault UUID")
    .requiredOption("--encrypted-data <hex>", "Encrypted data (hex)")
    .option("--access-aux-data <hex>", "Auxiliary access data", "0x")
    .option("--fee <wei>", "Override write fee (in wei)")
    .action(async (opts: any, cmd: Command) => {
      const globals = cmd.optsWithGlobals() as GlobalOptions;
      const client = createClient(globals);
      const result = await client.uploader.write({
        uuid: parseInt(opts.uuid),
        accessAuxData: opts.accessAuxData as `0x${string}`,
        encryptedData: opts.encryptedData as `0x${string}`,
        feeOverride: opts.fee ? BigInt(opts.fee) : undefined,
      });
      output(result, globals.json);
    });
}
