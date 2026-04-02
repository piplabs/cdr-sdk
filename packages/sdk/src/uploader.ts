import { parseEventLogs, toHex, type PublicClient, type WalletClient } from "viem";
import { cdrAbi, contractAddresses, type Network } from "@piplabs/cdr-contracts";
import { tdh2Encrypt, encryptFile, type TDH2Ciphertext } from "@piplabs/cdr-crypto";
import { uuidToLabel } from "./label.js";
import { ContentSizeExceededError } from "./errors.js";
import type { StorageProvider } from "./storage/types.js";

export class Uploader {
  private publicClient: PublicClient;
  private walletClient: WalletClient;
  private network: Network;

  /** Alias for {@link uploadCDR} */
  createVault: Uploader["uploadCDR"];
  /** Alias for {@link uploadFile} */
  createFileVault: Uploader["uploadFile"];

  constructor(params: {
    network: Network;
    publicClient: PublicClient;
    walletClient: WalletClient;
  }) {
    this.publicClient = params.publicClient;
    this.walletClient = params.walletClient;
    this.network = params.network;
    this.createVault = this.uploadCDR.bind(this);
    this.createFileVault = this.uploadFile.bind(this);
  }

  /**
   * Encrypt a data key using TDH2 to the DKG global public key.
   * @example
   * ```ts
   * const ciphertext = await uploader.encryptDataKey({
   *   dataKey: new TextEncoder().encode("secret"),
   *   globalPubKey,
   *   label: uuidToLabel(uuid),
   * });
   * ```
   */
  async encryptDataKey(params: {
    dataKey: Uint8Array;
    globalPubKey: Uint8Array;
    label: Uint8Array;
  }): Promise<TDH2Ciphertext> {
    return tdh2Encrypt({
      plaintext: params.dataKey,
      globalPubKey: params.globalPubKey,
      label: params.label,
    });
  }

  /**
   * Allocate a new vault on-chain. Auto-queries allocation fee unless feeOverride is provided.
   * @example
   * ```ts
   * const { uuid, txHash } = await uploader.allocate({
   *   updatable: false,
   *   writeConditionAddr: "0x...",
   *   readConditionAddr: "0x...",
   *   writeConditionData: "0x",
   *   readConditionData: "0x",
   * });
   * ```
   */
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

  /**
   * Write encrypted data to an existing vault. Auto-queries write fee.
   * @example
   * ```ts
   * const { txHash } = await uploader.write({
   *   uuid: 42,
   *   accessAuxData: "0x",
   *   encryptedData: "0x...",
   * });
   * ```
   */
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

    await this.publicClient.waitForTransactionReceipt({ hash: txHash });

    return { txHash };
  }

  /**
   * Convenience: allocate vault, encrypt data key with UUID-derived label, and write in one call.
   * @example
   * ```ts
   * const result = await uploader.uploadCDR({
   *   dataKey: new TextEncoder().encode("secret"),
   *   globalPubKey,
   *   updatable: false,
   *   writeConditionAddr: writeCondition.address,
   *   readConditionAddr: readCondition.address,
   *   writeConditionData: writeCondition.conditionData,
   *   readConditionData: readCondition.conditionData,
   *   accessAuxData: "0x",
   * });
   * console.log("UUID:", result.uuid);
   * ```
   */
  async uploadCDR(params: {
    dataKey: Uint8Array;
    globalPubKey: Uint8Array;
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
    // Step 1: Allocate vault first to get the UUID
    const { txHash: allocateTx, uuid } = await this.allocate({
      updatable: params.updatable,
      writeConditionAddr: params.writeConditionAddr,
      readConditionAddr: params.readConditionAddr,
      writeConditionData: params.writeConditionData,
      readConditionData: params.readConditionData,
      feeOverride: params.allocateFeeOverride,
    });

    // Step 2: Encrypt using UUID-derived label (matches validator's uuidToLabel)
    const label = uuidToLabel(uuid);
    const ciphertext = await this.encryptDataKey({
      dataKey: params.dataKey,
      globalPubKey: params.globalPubKey,
      label,
    });

    // Step 3: Write encrypted data to the vault
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

  /**
   * Encrypt a file, upload to storage, and write CID + key reference to a new vault.
   * @example
   * ```ts
   * const result = await uploader.uploadFile({
   *   content: fileBytes,
   *   storageProvider,
   *   globalPubKey,
   *   updatable: false,
   *   writeConditionAddr: "0x...",
   *   readConditionAddr: "0x...",
   *   writeConditionData: "0x",
   *   readConditionData: "0x",
   *   accessAuxData: "0x",
   * });
   * console.log("CID:", result.cid);
   * ```
   */
  async uploadFile(params: {
    content: Uint8Array;
    storageProvider: StorageProvider;
    globalPubKey: Uint8Array;
    updatable: boolean;
    writeConditionAddr: `0x${string}`;
    readConditionAddr: `0x${string}`;
    writeConditionData: `0x${string}`;
    readConditionData: `0x${string}`;
    accessAuxData: `0x${string}`;
    checkSize?: boolean;
    pin?: boolean;
    allocateFeeOverride?: bigint;
    writeFeeOverride?: bigint;
  }): Promise<{
    uuid: number;
    cid: string;
    ciphertext: TDH2Ciphertext;
    txHashes: { allocate: `0x${string}`; write: `0x${string}` };
  }> {
    const { content, storageProvider, checkSize = true, pin = true } = params;

    // Step 1: Encrypt file with ephemeral AES key
    const { ciphertext: encryptedFile, key } = encryptFile(content);

    // Step 2: Upload encrypted file to storage
    const cid = await storageProvider.upload(encryptedFile, { pin });

    // Step 3: Build vault payload JSON
    const payload = JSON.stringify({ cid, key: toHex(key) });
    const payloadBytes = new TextEncoder().encode(payload);

    // Step 4: Allocate vault
    const { txHash: allocateTx, uuid } = await this.allocate({
      updatable: params.updatable,
      writeConditionAddr: params.writeConditionAddr,
      readConditionAddr: params.readConditionAddr,
      writeConditionData: params.writeConditionData,
      readConditionData: params.readConditionData,
      feeOverride: params.allocateFeeOverride,
    });

    // Step 5: TDH2-encrypt the payload with UUID-derived label
    const label = uuidToLabel(uuid);
    const ciphertext = await this.encryptDataKey({
      dataKey: payloadBytes,
      globalPubKey: params.globalPubKey,
      label,
    });

    // Step 6: Size check on actual TDH2 ciphertext (default on)
    const encryptedDataHex = toHex(ciphertext.raw);
    if (checkSize) {
      const cdrAddress = contractAddresses[this.network].cdr;
      const maxSize = await this.publicClient.readContract({
        address: cdrAddress,
        abi: cdrAbi,
        functionName: "maxEncryptedDataSize",
      });
      if (BigInt(ciphertext.raw.length) > maxSize) {
        throw new ContentSizeExceededError(ciphertext.raw.length, maxSize);
      }
    }
    const { txHash: writeTx } = await this.write({
      uuid,
      accessAuxData: params.accessAuxData,
      encryptedData: encryptedDataHex,
      feeOverride: params.writeFeeOverride,
    });

    return {
      uuid,
      cid,
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
