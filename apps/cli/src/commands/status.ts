import { Command } from "commander";
import { createClient, output, type GlobalOptions } from "../utils.js";

export function statusCommand(program: Command) {
  const status = program.command("status").description("Query DKG/CDR state");

  status
    .command("vault <uuid>")
    .description("Get vault details by UUID")
    .action(async (uuid: string, _opts: any, cmd: Command) => {
      const globals = cmd.optsWithGlobals() as GlobalOptions;
      const client = createClient(globals);
      const vault = await client.observer.getVault(parseInt(uuid));
      output(vault, globals.json);
    });

  status
    .command("fees")
    .description("Get current CDR fees")
    .action(async (_opts: any, cmd: Command) => {
      const globals = cmd.optsWithGlobals() as GlobalOptions;
      const client = createClient(globals);
      const [allocate, write, read] = await Promise.all([
        client.observer.getAllocateFee(),
        client.observer.getWriteFee(),
        client.observer.getReadFee(),
      ]);
      output({ allocateFee: allocate, writeFee: write, readFee: read }, globals.json);
    });
}
