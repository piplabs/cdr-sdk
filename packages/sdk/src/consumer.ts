import { parseEventLogs, toBytes, type PublicClient, type WalletClient } from "viem";
import { cdrAbi, contractAddresses, type Network } from "@piplabs/cdr-contracts";
import { decryptPartial as eciesDecrypt, tdh2Combine, type TDH2Ciphertext, type DecryptedPartial } from "@piplabs/cdr-crypto";
import { PartialCollectionTimeoutError } from "./errors.js";
import type { PartialDecryptionEvent } from "./types.js";

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

  /**
   * Poll for EncryptedPartialDecryptionSubmitted events until minPartials are collected.
   * Filters by uuid to match events for this specific vault read request.
   */
  async collectPartials(params: {
    uuid: number;
    minPartials: number;
    fromBlock: bigint;
    timeoutMs?: number;
    pollIntervalMs?: number;
  }): Promise<PartialDecryptionEvent[]> {
    const { uuid, minPartials, fromBlock, timeoutMs = 60_000, pollIntervalMs = 3_000 } = params;
    const cdrAddress = contractAddresses[this.network].cdr;
    const deadline = Date.now() + timeoutMs;

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
        lastScannedBlock = currentBlock + 1n;

        const parsed = parseEventLogs({
          abi: cdrAbi,
          logs: rawLogs,
          eventName: "EncryptedPartialDecryptionSubmitted",
        });

        for (const log of parsed) {
          if (log.args.uuid === uuid) {
            const key = `${log.args.validator}-${log.args.pid}`;
            if (!collected.has(key)) {
              collected.set(key, {
                validator: log.args.validator,
                round: log.args.round,
                pid: log.args.pid,
                encryptedPartial: log.args.encryptedPartial,
                ephemeralPubKey: log.args.ephemeralPubKey,
                pubShare: log.args.pubShare,
                requesterPubKey: log.args.requesterPubKey,
                uuid: log.args.uuid,
                signature: log.args.signature,
              } as PartialDecryptionEvent);
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
          pid: p.pid,
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
    label: Uint8Array;
    threshold: number;
    timeoutMs?: number;
    feeOverride?: bigint;
  }): Promise<{ dataKey: Uint8Array; txHash: `0x${string}` }> {
    const vault = await this.publicClient.readContract({
      address: contractAddresses[this.network].cdr,
      abi: cdrAbi,
      functionName: "vaults",
      args: [params.uuid],
    });
    const vaultResult = vault as { encryptedData: `0x${string}` };
    const encryptedData = toBytes(vaultResult.encryptedData);

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
    });

    const dataKey = await this.decryptDataKey({
      ciphertext: { raw: encryptedData, label: params.label },
      partials,
      recipientPrivKey: params.recipientPrivKey,
      globalPubKey: params.globalPubKey,
      label: params.label,
      threshold: params.threshold,
    });

    return { dataKey, txHash };
  }
}
