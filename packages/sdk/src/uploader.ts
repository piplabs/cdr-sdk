import { parseEventLogs, toHex, toBytes, type PublicClient, type WalletClient } from "viem";
import { cdrAbi, contractAddresses, type Network } from "@piplabs/cdr-contracts";
import { tdh2Encrypt, encryptFile, getWasm, type TDH2Ciphertext } from "@piplabs/cdr-crypto";
import { uuidToLabel } from "./label.js";
import { ContentSizeExceededError, LabelMismatchError, InvalidConditionContractError } from "./errors.js";
import type { StorageProvider } from "./storage/types.js";
import { Observer } from "./observer.js";

export class Uploader {
  private publicClient: PublicClient;
  private walletClient: WalletClient;
  private network: Network;
  private observer: Observer;

  /** Alias for {@link uploadCDR} */
  createVault: Uploader["uploadCDR"];
  /** Alias for {@link uploadFile} */
  createFileVault: Uploader["uploadFile"];

  constructor(params: {
    network: Network;
    publicClient: PublicClient;
    walletClient: WalletClient;
    /** Observer instance — required. Used by `write` to look up `maxEncryptedDataSize` (cached for the Observer's lifetime). */
    observer: Observer;
  }) {
    this.publicClient = params.publicClient;
    this.walletClient = params.walletClient;
    this.network = params.network;
    this.observer = params.observer;
    this.createVault = this.uploadCDR.bind(this);
    this.createFileVault = this.uploadFile.bind(this);
  }

  /**
   * Encrypt a data key using TDH2 to the DKG global public key.
   * If `globalPubKey` is omitted, it is auto-queried via the Observer.
   * @example
   * ```ts
   * const ciphertext = await uploader.encryptDataKey({
   *   dataKey: new TextEncoder().encode("secret"),
   *   label: uuidToLabel(uuid),
   * });
   * ```
   */
  async encryptDataKey(params: {
    dataKey: Uint8Array;
    globalPubKey?: Uint8Array;
    label: Uint8Array;
  }): Promise<TDH2Ciphertext> {
    const globalPubKey =
      params.globalPubKey ?? (await this.observer.getGlobalPubKey());
    return tdh2Encrypt({
      plaintext: params.dataKey,
      globalPubKey,
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
    /**
     * Explicit allocation fee. Skips the auto-query for `allocateFee()`.
     * NOT a way to pay a different amount — the CDR contract requires
     * `msg.value == allocateFee` exactly and rejects mismatches with
     * "Invalid fee amount". Use this to skip a duplicate RPC when the
     * caller already has the fee value.
     */
    feeOverride?: bigint;
    /** Skip condition contract interface validation (default: false). */
    skipConditionValidation?: boolean;
  }): Promise<{ txHash: `0x${string}`; uuid: number }> {
    const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

    if (!params.skipConditionValidation) {
      if (params.writeConditionAddr !== ZERO_ADDRESS) {
        await this.validateConditionContract(params.writeConditionAddr, "write");
      }
      if (params.readConditionAddr !== ZERO_ADDRESS) {
        await this.validateConditionContract(params.readConditionAddr, "read");
      }
    }

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
    /**
     * Explicit write fee. Skips the auto-query for `writeFee()`. NOT a way
     * to pay a different amount — the CDR contract requires
     * `msg.value == writeFee` exactly and rejects mismatches with
     * "Invalid fee amount". Use this to skip a duplicate RPC when the
     * caller already has the fee value.
     */
    feeOverride?: bigint;
    /** Skip label binding validation (default: false). */
    skipLabelValidation?: boolean;
  }): Promise<{ txHash: `0x${string}` }> {
    const rawBytes = toBytes(params.encryptedData);

    // Label binding validation: extract the label from the serialized TDH2
    // ciphertext via WASM and compare against the expected UUID-derived label.
    if (!params.skipLabelValidation) {
      const expectedLabel = uuidToLabel(params.uuid);
      const wasm = getWasm();
      if (wasm && rawBytes.length > 0) {
        const actualLabel = wasm.tdh2ExtractLabel(rawBytes);
        if (actualLabel.length > 0 &&
            (actualLabel.length !== expectedLabel.length ||
             !actualLabel.every((b, i) => b === expectedLabel[i]))) {
          throw new LabelMismatchError(toHex(expectedLabel), toHex(actualLabel));
        }
      }
    }

    // Size validation: the CDR contract reverts on `data.length > maxEncryptedDataSize`.
    // Catch it client-side so the user gets a typed error before the tx is
    // submitted (saving gas + a wasted block wait). `maxEncryptedDataSize` is
    // a contract constant, cached for the Observer's lifetime.
    const maxSize = await this.observer.getMaxEncryptedDataSize();
    if (BigInt(rawBytes.length) > maxSize) {
      throw new ContentSizeExceededError(rawBytes.length, maxSize);
    }

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
   * If `globalPubKey` is omitted, it is auto-queried via the Observer.
   * @example
   * ```ts
   * const result = await uploader.uploadCDR({
   *   dataKey: new TextEncoder().encode("secret"),
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
    globalPubKey?: Uint8Array;
    updatable: boolean;
    writeConditionAddr: `0x${string}`;
    readConditionAddr: `0x${string}`;
    writeConditionData: `0x${string}`;
    readConditionData: `0x${string}`;
    accessAuxData: `0x${string}`;
    /** See {@link allocate}'s `feeOverride` — same strict-equality semantics. */
    allocateFeeOverride?: bigint;
    /** See {@link write}'s `feeOverride` — same strict-equality semantics. */
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
   * If `globalPubKey` is omitted, it is auto-queried via the Observer.
   * @example
   * ```ts
   * const result = await uploader.uploadFile({
   *   content: fileBytes,
   *   storageProvider,
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
    globalPubKey?: Uint8Array;
    updatable: boolean;
    writeConditionAddr: `0x${string}`;
    readConditionAddr: `0x${string}`;
    writeConditionData: `0x${string}`;
    readConditionData: `0x${string}`;
    accessAuxData: `0x${string}`;
    pin?: boolean;
    /** See {@link allocate}'s `feeOverride` — same strict-equality semantics. */
    allocateFeeOverride?: bigint;
    /** See {@link write}'s `feeOverride` — same strict-equality semantics. */
    writeFeeOverride?: bigint;
  }): Promise<{
    uuid: number;
    cid: string;
    ciphertext: TDH2Ciphertext;
    txHashes: { allocate: `0x${string}`; write: `0x${string}` };
  }> {
    const { content, storageProvider, pin = true } = params;

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

    // Step 6: Write to chain. Size validation lives in `write` itself
    // (cached against `Observer.getMaxEncryptedDataSize`), so we no longer
    // duplicate it here.
    const encryptedDataHex = toHex(ciphertext.raw);
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

  private async validateConditionContract(
    address: `0x${string}`,
    type: "write" | "read",
  ): Promise<void> {
    const functionName = type === "write" ? "checkWriteCondition" : "checkReadCondition";
    const conditionAbi = [{
      type: "function" as const,
      name: functionName,
      inputs: [
        { name: "uuid", type: "uint32" },
        { name: "accessAuxData", type: "bytes" },
        { name: "conditionData", type: "bytes" },
        { name: "caller", type: "address" },
      ],
      outputs: [{ name: "", type: "bool" }],
      stateMutability: "view" as const,
    }];

    // Zero-padded dummy bytes (256 bytes each) so well-formed conditions can
    // run their body to completion under abi.decode of common shapes and
    // return a value, rather than reverting on truncated input. That keeps
    // the empty-revert-data signal specific to "selector not found on this
    // contract" (dispatcher fallback path).
    const dummyBytes = `0x${"00".repeat(256)}` as `0x${string}`;
    const zeroAddr = "0x0000000000000000000000000000000000000000" as `0x${string}`;

    try {
      await this.publicClient.simulateContract({
        address,
        abi: conditionAbi,
        functionName,
        args: [0, dummyBytes, dummyBytes, zeroAddr],
      });
    } catch (e: any) {
      // Function exists iff the call reverted with a non-empty revert payload
      // (Error string, custom error, Panic, etc.). An empty `0x` revert is
      // the EVM dispatcher fallback path — the selector isn't routed.
      // ContractFunctionZeroDataError (EOA / no code at all) and any other
      // error surface as invalid too.
      const cause = e?.cause;
      if (cause?.name === "ContractFunctionRevertedError" && cause.raw !== "0x") {
        return;
      }
      throw new InvalidConditionContractError(address, type);
    }
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
