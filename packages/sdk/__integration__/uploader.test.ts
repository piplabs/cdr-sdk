/**
 * Integration tests for Uploader against a live EVM RPC + Story-API REST.
 *
 * Run all integration tests (from packages/sdk):
 *   pnpm test:integration
 *
 * Run only this file:
 *   pnpm test:integration uploader
 *
 * Required env (from `.env.local`):
 *   CDR_API_URL          — Story-API REST base URL
 *   CDR_RPC_URL          — EVM JSON-RPC URL on the same chain
 *   CDR_TEST_PRIVATE_KEY — funded wallet private key (anvil-0 public key on DevNet)
 *
 * Cost model:
 *   - encryptDataKey  → 0 IP (pure WASM, no chain I/O)
 *   - allocate        → ~1 × allocateFee (~0.01 IP per test)
 *   - uploadCDR       → ~1 × allocateFee + 1 × writeFee (~0.02 IP per test)
 *
 * Each test that calls allocate / uploadCDR creates a permanent vault on
 * chain — no cleanup possible. Acceptable on DevNet; do not run against
 * mainnet without intent.
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  http,
  toBytes,
  toHex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CDRClient, initWasm } from "../src/index.js";
import {
  ContentSizeExceededError,
  InvalidConditionContractError,
} from "../src/errors.js";
import { uuidToLabel } from "../src/label.js";
import { logCase } from "./_helpers.js";

const API_URL = process.env.CDR_API_URL;
const RPC_URL = process.env.CDR_RPC_URL;
const PRIVATE_KEY = process.env.CDR_TEST_PRIVATE_KEY as `0x${string}` | undefined;

if (!API_URL) {
  throw new Error("CDR_API_URL is not set. Configure it in .env.local.");
}
if (!RPC_URL) {
  throw new Error("CDR_RPC_URL is not set. Configure it in .env.local.");
}
if (!PRIVATE_KEY) {
  throw new Error("CDR_TEST_PRIVATE_KEY is not set. Configure it in .env.local.");
}

function makeCDRClient(): {
  client: CDRClient;
  publicClient: PublicClient;
  walletClient: WalletClient;
} {
  const account = privateKeyToAccount(PRIVATE_KEY!);
  const publicClient = createPublicClient({
    transport: http(RPC_URL),
  }) as unknown as PublicClient;
  const walletClient = createWalletClient({
    account,
    transport: http(RPC_URL),
  }) as unknown as WalletClient;
  const client = new CDRClient({
    network: "testnet",
    publicClient,
    walletClient,
    apiUrl: API_URL!,
  });
  return { client, publicClient, walletClient };
}

/**
 * Deploy a minimal "always-true" condition contract.
 *
 * Bytecode layout:
 *   PUSH1 0x0a  PUSH1 0x0c  PUSH1 0x00  CODECOPY
 *   PUSH1 0x0a  PUSH1 0x00  RETURN
 *   --- runtime (10 bytes) ---
 *   PUSH1 0x01  PUSH1 0x00  MSTORE  PUSH1 0x20  PUSH1 0x00  RETURN
 *
 * The runtime returns the 32-byte word `0x...01` for any call, which the
 * CDR contract interprets as "condition met". Same pattern used by
 * `piplabs/story-cdr-e2e` integration tests.
 */
async function deployOpenCondition(
  publicClient: PublicClient,
  walletClient: WalletClient,
): Promise<`0x${string}`> {
  const bytecode =
    "0x600a600c600039600a6000f3600160005260206000f3" as `0x${string}`;
  const txHash = await walletClient.sendTransaction({
    chain: walletClient.chain ?? null,
    account: walletClient.account ?? null,
    data: bytecode,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (!receipt.contractAddress) {
    throw new Error("Open-condition deployment did not produce a contractAddress");
  }
  return receipt.contractAddress;
}

describe(`Uploader integration tests (live: ${API_URL})`, () => {
  /**
   * Address of an "always-true" condition contract deployed once at suite
   * start and reused as `writeConditionAddr` / `readConditionAddr` in every
   * vault. The CDR contract rejects ZERO_ADDRESS and addresses with no code,
   * so we need a real contract — but the SDK's only requirement is that the
   * contract returns truthy for the condition check, which this minimal
   * 10-byte runtime does.
   */
  let openCondition: `0x${string}`;

  // 30s — DevNet block time is ~2.5s; deploy + receipt easily exceeds the
  // default 5s. Generous buffer for chain hiccups.
  beforeAll(async () => {
    // tdh2Encrypt requires the WASM module to be loaded.
    await initWasm();

    const { publicClient, walletClient } = makeCDRClient();
    openCondition = await deployOpenCondition(publicClient, walletClient);
    // eslint-disable-next-line no-console
    console.log(`\n[suite-setup] openCondition deployed at ${openCondition}\n`);
  }, 30_000);

  // -------------------------------------------------------------------------
  // encryptDataKey: pure crypto, zero EVM cost. Verifies that a real DevNet
  // globalPubKey + a fresh ephemeral keypair + a random dataKey produce a
  // well-shaped TDH2 ciphertext.
  // -------------------------------------------------------------------------

  it("encryptDataKey produces a well-shaped TDH2 ciphertext from real globalPubKey", async () => {
    const { client } = makeCDRClient();
    const globalPubKey = await client.observer.getGlobalPubKey();
    const dataKey = crypto.getRandomValues(new Uint8Array(32));
    // Label is a deterministic 32-byte fixture; encryptDataKey doesn't
    // touch the chain or validate uuid semantics, so any realistic uuid
    // works. 42 is a non-zero placeholder — avoids the all-zero-label
    // edge case that could mask a "label not threaded through to WASM"
    // bug.
    const label = uuidToLabel(42);

    const ciphertext = await client.uploader.encryptDataKey({
      dataKey,
      globalPubKey,
      label,
    });

    logCase("globalPubKey", globalPubKey);
    logCase("dataKey", dataKey);
    logCase("label", label);
    logCase("ciphertext", ciphertext);

    expect(ciphertext.raw).toBeInstanceOf(Uint8Array);
    expect(ciphertext.raw.length).toBeGreaterThan(0);
    expect(ciphertext.label).toBeInstanceOf(Uint8Array);
    expect(Array.from(ciphertext.label)).toEqual(Array.from(label));
  });

  it("encryptDataKey auto-queries globalPubKey via Observer when omitted", async () => {
    const { client } = makeCDRClient();
    const dataKey = crypto.getRandomValues(new Uint8Array(32));
    const label = uuidToLabel(42);

    // No globalPubKey passed — SDK should fall back to observer.getGlobalPubKey().
    // TDH2 encryption is randomized (the `r` scalar's encoded length can vary
    // by 1 byte across runs), so we don't compare against an explicit-key
    // re-encrypt; we only assert the auto-query path produces well-shaped
    // output. Unit-test coverage in __tests__/uploader.test.ts verifies that
    // observer.getGlobalPubKey is the actual fallback being invoked.
    const ciphertext = await client.uploader.encryptDataKey({
      dataKey,
      label,
    });

    logCase("ciphertext (auto-queried)", ciphertext);

    expect(ciphertext.raw).toBeInstanceOf(Uint8Array);
    expect(ciphertext.raw.length).toBeGreaterThan(0);
    expect(Array.from(ciphertext.label)).toEqual(Array.from(label));
  });

  // -------------------------------------------------------------------------
  // allocate: cheapest write — creates a vault with ZERO_ADDRESS conditions
  // (no condition contract validation needed). Confirms the keeper assigns
  // a uuid and the EVM tx lands.
  // -------------------------------------------------------------------------

  it("allocate creates a vault and returns uuid + txHash (open-condition)", async () => {
    const { client } = makeCDRClient();
    const result = await client.uploader.allocate({
      updatable: false,
      writeConditionAddr: openCondition,
      readConditionAddr: openCondition,
      writeConditionData: "0x",
      readConditionData: "0x",
    });
    logCase("uuid", result.uuid);
    logCase("txHash", result.txHash);

    expect(typeof result.uuid).toBe("number");
    expect(result.uuid).toBeGreaterThanOrEqual(0);
    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  }, 30_000);

  // -------------------------------------------------------------------------
  // uploadCDR end-to-end: allocate → encrypt → write. Confirms ciphertext
  // round-trips through the chain (we read the vault back and compare bytes).
  // -------------------------------------------------------------------------

  it("uploadCDR full flow: allocate + encrypt + write, then verify on-chain bytes", async () => {
    const { client } = makeCDRClient();
    const globalPubKey = await client.observer.getGlobalPubKey();
    const dataKey = crypto.getRandomValues(new Uint8Array(32));

    const result = await client.uploader.uploadCDR({
      dataKey,
      globalPubKey,
      updatable: false,
      writeConditionAddr: openCondition,
      readConditionAddr: openCondition,
      writeConditionData: "0x",
      readConditionData: "0x",
      accessAuxData: "0x",
    });

    logCase("uuid", result.uuid);
    logCase("txHashes", result.txHashes);
    logCase("ciphertext", result.ciphertext);

    expect(typeof result.uuid).toBe("number");
    expect(result.txHashes.allocate).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.txHashes.write).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.ciphertext.raw.length).toBeGreaterThan(0);

    // Round-trip: read vault back, verify encryptedData matches what we wrote.
    const vault = await client.observer.getVault(result.uuid);
    logCase("vault.encryptedData", toBytes(vault.encryptedData));

    expect(vault.encryptedData).toBe(toHex(result.ciphertext.raw));
    expect(vault.updatable).toBe(false);
    expect(vault.writeConditionAddr.toLowerCase()).toBe(openCondition.toLowerCase());
    expect(vault.readConditionAddr.toLowerCase()).toBe(openCondition.toLowerCase());
  }, 60_000);

  // -------------------------------------------------------------------------
  // write directly: allocate + encryptDataKey + write as three discrete steps
  // (vs uploadCDR's single bundled call). Verifies the discrete API surface
  // works end-to-end and the resulting on-chain bytes match.
  // -------------------------------------------------------------------------

  it("write directly: allocate → encryptDataKey → write produces a valid vault", async () => {
    const { client } = makeCDRClient();
    const globalPubKey = await client.observer.getGlobalPubKey();

    const { uuid } = await client.uploader.allocate({
      updatable: false,
      writeConditionAddr: openCondition,
      readConditionAddr: openCondition,
      writeConditionData: "0x",
      readConditionData: "0x",
    });
    logCase("uuid (from allocate)", uuid);

    const dataKey = crypto.getRandomValues(new Uint8Array(32));
    const ciphertext = await client.uploader.encryptDataKey({
      dataKey,
      globalPubKey,
      label: uuidToLabel(uuid),
    });

    const { txHash } = await client.uploader.write({
      uuid,
      accessAuxData: "0x",
      encryptedData: toHex(ciphertext.raw),
    });
    logCase("write txHash", txHash);

    expect(txHash).toMatch(/^0x[0-9a-f]{64}$/);

    const vault = await client.observer.getVault(uuid);
    expect(vault.encryptedData).toBe(toHex(ciphertext.raw));
    expect(vault.uuid).toBe(uuid);
  }, 60_000);

  // -------------------------------------------------------------------------
  // feeOverride: the CDR contract enforces `msg.value === fee` exactly
  // (not >=), so we can't prove plumbing by paying more. Instead we prove
  // it the other way: passing a deliberately wrong override reverts with
  // "CDR: Invalid fee amount". If the override were ignored, the auto-fee
  // path would have produced the correct value and the tx would have
  // succeeded — the revert is the proof that the override reached the chain.
  // -------------------------------------------------------------------------

  it("allocate with a wrong feeOverride reverts (proves override is plumbed to msg.value)", async () => {
    const { client } = makeCDRClient();
    const allocateFee = await client.observer.getAllocateFee();
    const wrongFee = allocateFee + 1n; // off by 1 wei
    logCase("fees", { autoAllocate: allocateFee, wrongOverride: wrongFee });

    await expect(
      client.uploader.allocate({
        updatable: false,
        writeConditionAddr: openCondition,
        readConditionAddr: openCondition,
        writeConditionData: "0x",
        readConditionData: "0x",
        feeOverride: wrongFee,
      }),
    ).rejects.toThrow(/Invalid fee amount/i);
  }, 30_000);

  // -------------------------------------------------------------------------
  // Pre-flight size guard: write throws ContentSizeExceededError before
  // any tx is submitted when encryptedData exceeds maxEncryptedDataSize.
  // -------------------------------------------------------------------------

  it("write throws ContentSizeExceededError when encryptedData exceeds maxEncryptedDataSize", async () => {
    const { client } = makeCDRClient();

    // Allocate a real vault first so the uuid is valid.
    const { uuid } = await client.uploader.allocate({
      updatable: false,
      writeConditionAddr: openCondition,
      readConditionAddr: openCondition,
      writeConditionData: "0x",
      readConditionData: "0x",
    });

    const maxSize = await client.observer.getMaxEncryptedDataSize();
    // 1 byte over the cap. `skipLabelValidation` bypasses the WASM
    // tdh2ExtractLabel call that would otherwise choke on raw garbage bytes;
    // we only want to test the size guard here.
    const oversize = Number(maxSize) + 1;
    const oversized = ("0x" + "ab".repeat(oversize)) as `0x${string}`;
    logCase("size", { maxEncryptedDataSize: maxSize, oversizedPayloadBytes: oversize });

    await expect(
      client.uploader.write({
        uuid,
        accessAuxData: "0x",
        encryptedData: oversized,
        skipLabelValidation: true,
      }),
    ).rejects.toThrow(ContentSizeExceededError);
  }, 30_000);

  // -------------------------------------------------------------------------
  // Condition contract validation policy.
  //
  // The CDR contract itself ACCEPTS an EOA as writeConditionAddr /
  // readConditionAddr — verified empirically with `cast call allocate(...)`,
  // which returned a fresh uuid with no revert. The SDK adds a stricter
  // client-side gate via `validateConditionContract`: it probes the address
  // with `simulateContract(checkWriteCondition / checkReadCondition)` and
  // throws `InvalidConditionContractError` if there's no contract code (a
  // typo'd address, or the user accidentally pasting a wallet address).
  //
  // Default = strict. Escape hatch = `skipConditionValidation: true`. We
  // assert both directions of the policy on both write and read sides so
  // a regression on either branch (selector swapped, try/catch wrong, etc.)
  // surfaces.
  // -------------------------------------------------------------------------

  it("default policy rejects EOA as writeConditionAddr (InvalidConditionContractError, type=write)", async () => {
    const { client, walletClient } = makeCDRClient();
    const eoa = walletClient.account!.address;
    logCase("EOA used as writeConditionAddr", eoa);

    await expect(
      client.uploader.allocate({
        updatable: false,
        writeConditionAddr: eoa,
        readConditionAddr: openCondition,
        writeConditionData: "0x",
        readConditionData: "0x",
      }),
    ).rejects.toThrow(InvalidConditionContractError);
  }, 30_000);

  it("default policy rejects EOA as readConditionAddr (InvalidConditionContractError, type=read)", async () => {
    const { client, walletClient } = makeCDRClient();
    const eoa = walletClient.account!.address;
    logCase("EOA used as readConditionAddr", eoa);

    await expect(
      client.uploader.allocate({
        updatable: false,
        writeConditionAddr: openCondition,
        readConditionAddr: eoa,
        writeConditionData: "0x",
        readConditionData: "0x",
      }),
    ).rejects.toThrow(InvalidConditionContractError);
  }, 30_000);

  it("skipConditionValidation:true allows EOA as writeConditionAddr (escape hatch)", async () => {
    const { client, walletClient } = makeCDRClient();
    const eoa = walletClient.account!.address;
    logCase("EOA used as writeConditionAddr (skip=true)", eoa);

    const result = await client.uploader.allocate({
      updatable: false,
      writeConditionAddr: eoa,
      readConditionAddr: openCondition,
      writeConditionData: "0x",
      readConditionData: "0x",
      skipConditionValidation: true,
    });
    logCase("uuid + txHash", result);

    expect(typeof result.uuid).toBe("number");
    expect(result.uuid).toBeGreaterThanOrEqual(0);
    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/);

    // Verify on-chain vault was actually created with the EOA address.
    const vault = await client.observer.getVault(result.uuid);
    expect(vault.writeConditionAddr.toLowerCase()).toBe(eoa.toLowerCase());
  }, 30_000);

  it("skipConditionValidation:true allows EOA as readConditionAddr (escape hatch)", async () => {
    const { client, walletClient } = makeCDRClient();
    const eoa = walletClient.account!.address;
    logCase("EOA used as readConditionAddr (skip=true)", eoa);

    const result = await client.uploader.allocate({
      updatable: false,
      writeConditionAddr: openCondition,
      readConditionAddr: eoa,
      writeConditionData: "0x",
      readConditionData: "0x",
      skipConditionValidation: true,
    });

    expect(typeof result.uuid).toBe("number");
    expect(result.uuid).toBeGreaterThanOrEqual(0);

    const vault = await client.observer.getVault(result.uuid);
    expect(vault.readConditionAddr.toLowerCase()).toBe(eoa.toLowerCase());
  }, 30_000);

  it("skipConditionValidation:true allows EOA on both sides simultaneously", async () => {
    const { client, walletClient } = makeCDRClient();
    const eoa = walletClient.account!.address;
    logCase("EOA used on both sides (skip=true)", eoa);

    const result = await client.uploader.allocate({
      updatable: false,
      writeConditionAddr: eoa,
      readConditionAddr: eoa,
      writeConditionData: "0x",
      readConditionData: "0x",
      skipConditionValidation: true,
    });

    expect(typeof result.uuid).toBe("number");

    const vault = await client.observer.getVault(result.uuid);
    expect(vault.writeConditionAddr.toLowerCase()).toBe(eoa.toLowerCase());
    expect(vault.readConditionAddr.toLowerCase()).toBe(eoa.toLowerCase());
  }, 30_000);

  // -------------------------------------------------------------------------
  // File-based vault APIs (`Uploader.uploadFile`) are intentionally not
  // exercised here. The SDK only exposes the `StorageProvider` interface;
  // concrete adapters (Helia, Storacha, Synapse, …) are supplied by the
  // consuming application. Integration testing of those adapters is the
  // consumer's responsibility, not the SDK's.
  // -------------------------------------------------------------------------
});
