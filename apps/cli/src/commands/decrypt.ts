import { Command } from "commander";
import { toHex } from "viem";
import { decryptPartial } from "@piplabs/cdr-sdk";
import { output, type GlobalOptions } from "../utils.js";

export function decryptCommand(program: Command) {
  program
    .command("decrypt-partial")
    .description("ECIES-decrypt an encrypted partial decryption from a validator")
    .requiredOption("--encrypted-partial <hex>", "Encrypted partial (hex)")
    .requiredOption("--ephemeral-pub-key <hex>", "Validator ephemeral public key (hex)")
    .requiredOption("--recipient-priv-key <hex>", "Requester private key (hex)")
    .action(async (opts: any, cmd: Command) => {
      const globals = cmd.optsWithGlobals() as GlobalOptions;

      const encryptedPartial = Buffer.from(opts.encryptedPartial.replace(/^0x/, ""), "hex");
      const ephemeralPubKey = Buffer.from(opts.ephemeralPubKey.replace(/^0x/, ""), "hex");
      const recipientPrivKey = Buffer.from(opts.recipientPrivKey.replace(/^0x/, ""), "hex");

      const decrypted = await decryptPartial({
        encryptedPartial: new Uint8Array(encryptedPartial),
        ephemeralPubKey: new Uint8Array(ephemeralPubKey),
        recipientPrivKey: new Uint8Array(recipientPrivKey),
      });

      output({ decryptedPartial: toHex(decrypted) }, globals.json);
    });
}
