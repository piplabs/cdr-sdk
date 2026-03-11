import { parseEventLogs, toHex, type PublicClient, type WalletClient } from "viem";
import { cdrAbi, contractAddresses, type Network } from "@piplabs/cdr-contracts";
import { tdh2Encrypt, type TDH2Ciphertext } from "@piplabs/cdr-crypto";

export class Uploader {
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

  /** Encrypt a data key using TDH2 to the DKG global public key */
  async encryptDataKey(params: {
    dataKey: Uint8Array;
    globalPubKey: Uint8Array;
    label: string;
  }): Promise<TDH2Ciphertext> {
    return tdh2Encrypt({
      plaintext: params.dataKey,
      globalPubKey: params.globalPubKey,
      label: new TextEncoder().encode(params.label),
    });
  }

  /** Allocate a new vault on-chain. Auto-queries allocation fee unless feeOverride is provided. */
  async allocate(params: {
    updatable: boolean;
    writeConditionAddr: `0x${string}`;
    readConditionAddr: `0x${string}`;
    writeConditionData: `0x${string}`;
    readConditionData: `0x${string}`;
    feeOverride?: bigint;
    // TODO: In the future, add a `validateConditions: boolean` param
    // to check for the existence of the required method signatures
    // (checkWriteCondition / checkReadCondition) on the condition
    // contract addresses before submitting the transaction.
  }): Promise<{ txHash: `0x${string}`; uuid: number }> {
    const cdrAddress = contractAddresses[this.network].cdr;

    const fee = params.feeOverride ?? await this.publicClient.readContract({
      address: cdrAddress,
      abi: cdrAbi,
      functionName: "allocateFee",
    });

    const txHash = await this.walletClient.writeContract({
      chain: this.walletClient.chain ?? null,
      account: this.walletClient.account ?? null,
      address: cdrAddress,
      abi: cdrAbi,
      functionName: "allocate",
      args: [
        params.updatable,
        params.writeConditionAddr,
        params.readConditionAddr,
        params.writeConditionData,
        params.readConditionData,
      ],
      value: fee,
    });

    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    const uuid = this.parseVaultAllocatedUuid(receipt.logs);

    return { txHash, uuid };
  }

  /** Write encrypted data to an existing vault. Auto-queries write fee. */
  async write(params: {
    uuid: number;
    accessAuxData: `0x${string}`;
    encryptedData: `0x${string}`;
    feeOverride?: bigint;
  }): Promise<{ txHash: `0x${string}` }> {
    const cdrAddress = contractAddresses[this.network].cdr;

    const fee = params.feeOverride ?? await this.publicClient.readContract({
      address: cdrAddress,
      abi: cdrAbi,
      functionName: "writeFee",
    });

    const txHash = await this.walletClient.writeContract({
      chain: this.walletClient.chain ?? null,
      account: this.walletClient.account ?? null,
      address: cdrAddress,
      abi: cdrAbi,
      functionName: "write",
      args: [params.uuid, params.accessAuxData, params.encryptedData],
      value: fee,
    });

    return { txHash };
  }

  /** Convenience: encrypt data key, allocate vault, and write encrypted data in one call */
  async uploadCDR(params: {
    dataKey: Uint8Array;
    globalPubKey: Uint8Array;
    label: string;
    updatable: boolean;
    writeConditionAddr: `0x${string}`;
    readConditionAddr: `0x${string}`;
    writeConditionData: `0x${string}`;
    readConditionData: `0x${string}`;
    accessAuxData: `0x${string}`;
    allocateFeeOverride?: bigint;
    writeFeeOverride?: bigint;
  }): Promise<{
    uuid: number;
    ciphertext: TDH2Ciphertext;
    txHashes: { allocate: `0x${string}`; write: `0x${string}` };
  }> {
    const ciphertext = await this.encryptDataKey({
      dataKey: params.dataKey,
      globalPubKey: params.globalPubKey,
      label: params.label,
    });

    const { txHash: allocateTx, uuid } = await this.allocate({
      updatable: params.updatable,
      writeConditionAddr: params.writeConditionAddr,
      readConditionAddr: params.readConditionAddr,
      writeConditionData: params.writeConditionData,
      readConditionData: params.readConditionData,
      feeOverride: params.allocateFeeOverride,
    });

    const encryptedDataHex = toHex(ciphertext.raw);
    const { txHash: writeTx } = await this.write({
      uuid,
      accessAuxData: params.accessAuxData,
      encryptedData: encryptedDataHex,
      feeOverride: params.writeFeeOverride,
    });

    return {
      uuid,
      ciphertext,
      txHashes: { allocate: allocateTx, write: writeTx },
    };
  }

  private parseVaultAllocatedUuid(logs: any[]): number {
    const parsed = parseEventLogs({
      abi: cdrAbi,
      logs,
      eventName: "VaultAllocated",
    });
    if (parsed.length === 0) {
      throw new Error("VaultAllocated event not found in transaction logs");
    }
    return parsed[0].args.uuid;
  }
}
