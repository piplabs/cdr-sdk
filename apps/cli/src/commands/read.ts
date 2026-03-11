import { Command } from "commander";
import { createClient, output, type GlobalOptions } from "../utils.js";

export function readCommand(program: Command) {
  program
    .command("read")
    .description("Request a vault read (emits VaultRead event for validators)")
    .requiredOption("--uuid <number>", "Vault UUID")
    .requiredOption("--requester-pub-key <hex>", "Requester public key (hex)")
    .option("--access-aux-data <hex>", "Auxiliary access data", "0x")
    .option("--fee <wei>", "Override read fee (in wei)")
    .action(async (opts: any, cmd: Command) => {
      const globals = cmd.optsWithGlobals() as GlobalOptions;
      const client = createClient(globals);
      const result = await client.consumer.read({
        uuid: parseInt(opts.uuid),
        accessAuxData: opts.accessAuxData as `0x${string}`,
        requesterPubKey: opts.requesterPubKey as `0x${string}`,
        feeOverride: opts.fee ? BigInt(opts.fee) : undefined,
      });
      output(result, globals.json);
    });
}
