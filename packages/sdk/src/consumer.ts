import { parseEventLogs, toBytes, fromHex, type PublicClient, type WalletClient } from "viem";
import { cdrAbi, dkgAbi, contractAddresses, type Network } from "@piplabs/cdr-contracts";
import { decryptPartial as eciesDecrypt, tdh2Combine, verifyPartialSignature, decryptFile, type TDH2Ciphertext, type DecryptedPartial } from "@piplabs/cdr-crypto";
import { PartialCollectionTimeoutError } from "./errors.js";
import type { PartialDecryptionEvent } from "./types.js";
import { uuidToLabel } from "./label.js";
import type { StorageProvider } from "./storage/types.js";

export class Consumer {
  private publicClient: PublicClient;
  private walletClient: WalletClient;
  private network: Network;

  constructor(params: {
    network: Network;
    publicClient: PublicClient;
    walletClient: WalletClient;
  }) {
    this.publicClient = params.publicClient;
    this.walletClient = params.walletClient;
    this.network = params.network;
  }

  /** Request a vault read. Auto-queries read fee. Emits VaultRead event for validators. */
  async read(params: {
    uuid: number;
    accessAuxData: `0x${string}`;
    requesterPubKey: `0x${string}`;
    feeOverride?: bigint;
  }): Promise<{ txHash: `0x${string}` }> {
    const cdrAddress = contractAddresses[this.network].cdr;

    const fee = params.feeOverride ?? await this.publicClient.readContract({
      address: cdrAddress,
      abi: cdrAbi,
      functionName: "readFee",
    });

    const txHash = await this.walletClient.writeContract({
      chain: this.walletClient.chain ?? null,
      account: this.walletClient.account ?? null,
      address: cdrAddress,
      abi: cdrAbi,
      functionName: "read",
      args: [params.uuid, params.accessAuxData, params.requesterPubKey],
      value: fee,
    });

    return { txHash };
  }

  /** Fetch validator address → commPubKey map from DKG Registered events */
  private async getCommPubKeyMap(): Promise<Map<string, Uint8Array>> {
    const dkgAddress = contractAddresses[this.network].dkg;

    const rawLogs = await this.publicClient.getLogs({
      address: dkgAddress,
      fromBlock: BigInt(0),
      toBlock: "latest",
    });

    const parsed = parseEventLogs({
      abi: dkgAbi,
      logs: rawLogs,
      eventName: "Registered",
    });

    const validators = new Map<string, Uint8Array>();
    for (const log of parsed) {
      const addr = log.args.validatorAddr.toLowerCase() as `0x${string}`;
      validators.set(addr, toBytes(log.args.enclaveCommKey));
    }

    return validators;
  }

  /**
   * Poll for EncryptedPartialDecryptionSubmitted events until minPartials are collected.
   * Filters by uuid to match events for this specific vault read request.
   * Verifies each partial's TEE signature; invalid partials are skipped.
   */
  async collectPartials(params: {
    uuid: number;
    minPartials: number;
    fromBlock: bigint;
    timeoutMs?: number;
    pollIntervalMs?: number;
    /** Called when a partial fails signature verification. If not provided, invalid partials are silently skipped. */
    onInvalidPartial?: (event: PartialDecryptionEvent, error: Error) => void;
  }): Promise<PartialDecryptionEvent[]> {
    const { uuid, minPartials, fromBlock, timeoutMs = 60_000, pollIntervalMs = 3_000, onInvalidPartial } = params;
    const cdrAddress = contractAddresses[this.network].cdr;
    const deadline = Date.now() + timeoutMs;

    // Build commPubKey map from DKG Registered events
    const commPubKeyMap = await this.getCommPubKeyMap();

    let lastScannedBlock = fromBlock;
    const collected = new Map<string, PartialDecryptionEvent>();

    while (Date.now() < deadline) {
      const currentBlock = await this.publicClient.getBlockNumber();
      if (currentBlock >= lastScannedBlock) {
        const rawLogs = await this.publicClient.getLogs({
          address: cdrAddress,
          fromBlock: lastScannedBlock,
          toBlock: currentBlock,
        });
        lastScannedBlock = currentBlock + BigInt(1);

        const parsed = parseEventLogs({
          abi: cdrAbi,
          logs: rawLogs,
          eventName: "EncryptedPartialDecryptionSubmitted",
        });

        for (const log of parsed) {
          if (log.args.uuid === uuid) {
            const key = `${log.args.validator}-${log.args.pid}`;
            if (!collected.has(key)) {
              const event: PartialDecryptionEvent = {
                validator: log.args.validator,
                round: log.args.round,
                pid: log.args.pid,
                encryptedPartial: log.args.encryptedPartial,
                ephemeralPubKey: log.args.ephemeralPubKey,
                pubShare: log.args.pubShare,
                requesterPubKey: log.args.requesterPubKey,
                uuid: log.args.uuid,
                signature: log.args.signature,
              };

              // Verify signature
              const validatorAddr = log.args.validator.toLowerCase();
              const commPubKey = commPubKeyMap.get(validatorAddr);

              if (!commPubKey) {
                onInvalidPartial?.(event, new Error(`unknown validator: ${log.args.validator}`));
                continue;
              }

              const valid = verifyPartialSignature({
                round: event.round,
                ciphertext: toBytes(log.args.ciphertext),
                encryptedPartial: toBytes(event.encryptedPartial),
                ephemeralPubKey: toBytes(event.ephemeralPubKey),
                pubShare: toBytes(event.pubShare),
                signature: toBytes(event.signature),
                commPubKey,
              });

              if (!valid) {
                onInvalidPartial?.(event, new Error(`invalid signature from validator ${log.args.validator}`));
                continue;
              }

              collected.set(key, event);
            }
          }
        }
      }

      if (collected.size >= minPartials) {
        return [...collected.values()].slice(0, minPartials);
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new PartialCollectionTimeoutError(collected.size, minPartials, timeoutMs);
  }

  /** Decrypt collected partials and combine to recover the original data key */
  async decryptDataKey(params: {
    ciphertext: TDH2Ciphertext;
    partials: PartialDecryptionEvent[];
    recipientPrivKey: Uint8Array;
    globalPubKey: Uint8Array;
    label: Uint8Array;
    threshold: number;
  }): Promise<Uint8Array> {
    const { ciphertext, partials, recipientPrivKey, globalPubKey, label, threshold } = params;

    const decryptedPartials: DecryptedPartial[] = await Promise.all(
      partials.map(async (p) => {
        const decrypted = await eciesDecrypt({
          encryptedPartial: toBytes(p.encryptedPartial),
          ephemeralPubKey: toBytes(p.ephemeralPubKey),
          recipientPrivKey,
        });
        return {
          name: String(p.pid),
          pubShare: toBytes(p.pubShare),
          partial: decrypted,
        };
      }),
    );

    return tdh2Combine({
      ciphertext,
      partials: decryptedPartials,
      globalPubKey,
      label,
      threshold,
    });
  }

  /** Convenience: read + collect + decrypt in one call */
  async accessCDR(params: {
    uuid: number;
    accessAuxData: `0x${string}`;
    requesterPubKey: `0x${string}`;
    recipientPrivKey: Uint8Array;
    globalPubKey: Uint8Array;
    threshold: number;
    timeoutMs?: number;
    feeOverride?: bigint;
    onInvalidPartial?: (event: PartialDecryptionEvent, error: Error) => void;
  }): Promise<{ dataKey: Uint8Array; txHash: `0x${string}` }> {
    const vault = await this.publicClient.readContract({
      address: contractAddresses[this.network].cdr,
      abi: cdrAbi,
      functionName: "vaults",
      args: [params.uuid],
    });
    const vaultResult = vault as { encryptedData: `0x${string}` };
    const encryptedData = toBytes(vaultResult.encryptedData);

    const label = uuidToLabel(params.uuid);

    const fromBlock = await this.publicClient.getBlockNumber();
    const { txHash } = await this.read({
      uuid: params.uuid,
      accessAuxData: params.accessAuxData,
      requesterPubKey: params.requesterPubKey,
      feeOverride: params.feeOverride,
    });

    const partials = await this.collectPartials({
      uuid: params.uuid,
      minPartials: params.threshold,
      fromBlock,
      timeoutMs: params.timeoutMs,
      onInvalidPartial: params.onInvalidPartial,
    });

    const dataKey = await this.decryptDataKey({
      ciphertext: { raw: encryptedData, label },
      partials,
      recipientPrivKey: params.recipientPrivKey,
      globalPubKey: params.globalPubKey,
      label,
      threshold: params.threshold,
    });

    return { dataKey, txHash };
  }

  /** Convenience: access vault, parse CID + key payload, download from storage, and decrypt file */
  async downloadFile(params: {
    uuid: number;
    accessAuxData: `0x${string}`;
    requesterPubKey: `0x${string}`;
    recipientPrivKey: Uint8Array;
    globalPubKey: Uint8Array;
    threshold: number;
    storageProvider: StorageProvider;
    timeoutMs?: number;
    feeOverride?: bigint;
    onInvalidPartial?: (event: PartialDecryptionEvent, error: Error) => void;
  }): Promise<{
    content: Uint8Array;
    cid: string;
    txHash: `0x${string}`;
  }> {
    // Step 1: Access vault to get decrypted payload
    const { dataKey: payloadBytes, txHash } = await this.accessCDR({
      uuid: params.uuid,
      accessAuxData: params.accessAuxData,
      requesterPubKey: params.requesterPubKey,
      recipientPrivKey: params.recipientPrivKey,
      globalPubKey: params.globalPubKey,
      threshold: params.threshold,
      timeoutMs: params.timeoutMs,
      feeOverride: params.feeOverride,
      onInvalidPartial: params.onInvalidPartial,
    });

    // Step 2: Parse JSON payload
    const payloadStr = new TextDecoder().decode(payloadBytes);
    const { cid, key: keyHex } = JSON.parse(payloadStr) as { cid: string; key: `0x${string}` };
    const key = fromHex(keyHex, "bytes");

    // Step 3: Download encrypted file from storage
    const encryptedFile = await params.storageProvider.download(cid);

    // Step 4: Decrypt file
    const content = decryptFile({ ciphertext: encryptedFile, key });

    return { content, cid, txHash };
  }
}
