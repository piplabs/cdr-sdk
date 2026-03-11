import { Command } from "commander";
import { createClient, output, type GlobalOptions } from "../utils.js";

export function allocateCommand(program: Command) {
  program
    .command("allocate")
    .description("Allocate a new CDR vault")
    .requiredOption("--write-condition <addr>", "Write condition contract address")
    .requiredOption("--read-condition <addr>", "Read condition contract address")
    .option("--updatable", "Allow vault data to be updated", false)
    .option("--write-condition-data <hex>", "Write condition data", "0x")
    .option("--read-condition-data <hex>", "Read condition data", "0x")
    .option("--fee <wei>", "Override allocation fee (in wei)")
    .action(async (opts: any, cmd: Command) => {
      const globals = cmd.optsWithGlobals() as GlobalOptions;
      const client = createClient(globals);
      const result = await client.uploader.allocate({
        updatable: opts.updatable,
        writeConditionAddr: opts.writeCondition as `0x${string}`,
        readConditionAddr: opts.readCondition as `0x${string}`,
        writeConditionData: opts.writeConditionData as `0x${string}`,
        readConditionData: opts.readConditionData as `0x${string}`,
        feeOverride: opts.fee ? BigInt(opts.fee) : undefined,
      });
      output(result, globals.json);
    });
}
