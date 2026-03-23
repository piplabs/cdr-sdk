import { Command } from "commander";
import { toHex } from "viem";
import { initWasm, uuidToLabel } from "@piplabs/cdr-sdk";
import { output, type GlobalOptions } from "../utils.js";
import { tdh2Encrypt } from "@piplabs/cdr-sdk";

export function encryptCommand(program: Command) {
  program
    .command("encrypt")
    .description("Encrypt a data key using TDH2 threshold encryption")
    .requiredOption("--data-key <hex>", "Data key to encrypt (hex)")
    .requiredOption("--global-pub-key <hex>", "DKG global public key (hex)")
    .requiredOption("--uuid <number>", "Vault UUID (used to derive the TDH2 label)")
    .action(async (opts: any, cmd: Command) => {
      const globals = cmd.optsWithGlobals() as GlobalOptions;

      await initWasm();

      const dataKey = Buffer.from(opts.dataKey.replace(/^0x/, ""), "hex");
      const globalPubKey = Buffer.from(opts.globalPubKey.replace(/^0x/, ""), "hex");
      const uuid = Number(opts.uuid);
      if (!Number.isInteger(uuid) || uuid < 0 || uuid > 0xFFFFFFFF) {
        throw new Error("--uuid must be an integer in range [0, 4294967295]");
      }
      const label = uuidToLabel(uuid);

      const ciphertext = await tdh2Encrypt({
        plaintext: new Uint8Array(dataKey),
        globalPubKey: new Uint8Array(globalPubKey),
        label,
      });

      output({ ciphertext: toHex(ciphertext.raw), label: toHex(ciphertext.label) }, globals.json);
    });
}
