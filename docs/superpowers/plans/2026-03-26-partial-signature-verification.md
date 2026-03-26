# Partial Decryption Signature Verification — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add signature verification to the SDK so `collectPartials` rejects tampered partial decryptions, matching the kernel's RLP-encoded signing protocol.

**Architecture:** New `verifyPartialSignature()` function in `@piplabs/cdr-crypto` reproduces the kernel's signing material (RLP encode → Keccak256 → secp256k1 ecrecover). `Observer` gets a `getRegisteredValidators()` method to resolve validator → commPubKey mappings. `Consumer.collectPartials` wires both together, skipping invalid partials and invoking an optional callback.

**Tech Stack:** `@ethereumjs/rlp` (RLP encoding), `@noble/curves/secp256k1` (ecrecover), `viem` (keccak256), `vitest` (tests)

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `packages/crypto/src/signature.ts` | Create | `verifyPartialSignature()` — RLP encode, hash, ecrecover, compare |
| `packages/crypto/src/index.ts` | Modify | Export `verifyPartialSignature` |
| `packages/crypto/package.json` | Modify | Add `@ethereumjs/rlp` dependency |
| `packages/crypto/__tests__/signature.test.ts` | Create | Unit tests for signature verification |
| `packages/sdk/src/observer.ts` | Modify | Add `getRegisteredValidators()` method |
| `packages/sdk/__tests__/observer.test.ts` | Modify | Add tests for `getRegisteredValidators()` |
| `packages/sdk/src/consumer.ts` | Modify | Integrate verification into `collectPartials` and `accessCDR` |
| `packages/sdk/__tests__/consumer.test.ts` | Modify | Add tests for verification in collect flow |

---

### Task 1: Add `@ethereumjs/rlp` dependency to crypto package

**Files:**
- Modify: `packages/crypto/package.json`

- [ ] **Step 1: Install the dependency**

```bash
cd /Users/jwpark/Work/PIPLabs/project-cdr/cdr-sdk && pnpm add @ethereumjs/rlp --filter @piplabs/cdr-crypto
```

Expected: `@ethereumjs/rlp` appears in `packages/crypto/package.json` under `dependencies`.

- [ ] **Step 2: Commit**

```bash
git add packages/crypto/package.json pnpm-lock.yaml
git commit -m "chore(crypto): add @ethereumjs/rlp dependency"
```

---

### Task 2: Write failing tests for `verifyPartialSignature`

**Files:**
- Create: `packages/crypto/__tests__/signature.test.ts`

- [ ] **Step 1: Write the test file**

This test reproduces the kernel's signing protocol in JS to create known-good signatures, then verifies the function accepts valid and rejects invalid ones.

```typescript
import { describe, it, expect } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak256, toBytes } from "viem";
import { RLP } from "@ethereumjs/rlp";
import { verifyPartialSignature } from "../src/signature.js";

/**
 * Reproduce the kernel's signPartialDecryptResponse in JS.
 * Go RLP encodes a struct as a list: [Round, Ciphertext, EncryptedPartial, EphemeralPubKey, PubShare]
 * where uint32 is encoded as a minimal-byte integer.
 */
function kernelSign(params: {
  round: number;
  ciphertext: Uint8Array;
  encryptedPartial: Uint8Array;
  ephemeralPubKey: Uint8Array;
  pubShare: Uint8Array;
  privateKey: Uint8Array;
}): Uint8Array {
  const roundBytes = uint32ToMinimalBytes(params.round);
  const encoded = RLP.encode([
    roundBytes,
    params.ciphertext,
    params.encryptedPartial,
    params.ephemeralPubKey,
    params.pubShare,
  ]);
  const hash = toBytes(keccak256(encoded));

  const sig = secp256k1.sign(hash, params.privateKey);
  const sigBytes = new Uint8Array(65);
  sigBytes.set(sig.toCompactRawBytes(), 0);
  // recovery id: kernel adds 27 if < 27
  sigBytes[64] = sig.recovery + 27;
  return sigBytes;
}

/** Encode uint32 as minimal big-endian bytes (no leading zeros), matching Go RLP uint encoding. */
function uint32ToMinimalBytes(value: number): Uint8Array {
  if (value === 0) return new Uint8Array(0);
  const buf = new Uint8Array(4);
  const view = new DataView(buf.buffer);
  view.setUint32(0, value, false);
  let start = 0;
  while (start < 3 && buf[start] === 0) start++;
  return buf.slice(start);
}

describe("verifyPartialSignature", () => {
  function makeTestData() {
    const privateKey = secp256k1.utils.randomPrivateKey();
    // commPubKey is 64 bytes: uncompressed pubkey without the 0x04 prefix
    const fullPubKey = secp256k1.getPublicKey(privateKey, false);
    const commPubKey = fullPubKey.slice(1); // drop 0x04 prefix → 64 bytes

    const round = 1;
    const ciphertext = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const encryptedPartial = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const ephemeralPubKey = new Uint8Array([0xca, 0xfe, 0x00, 0x00]);
    const pubShare = new Uint8Array([0xba, 0xbe, 0x00, 0x00]);

    const signature = kernelSign({
      round,
      ciphertext,
      encryptedPartial,
      ephemeralPubKey,
      pubShare,
      privateKey,
    });

    return { round, ciphertext, encryptedPartial, ephemeralPubKey, pubShare, signature, commPubKey, privateKey };
  }

  it("returns true for a valid kernel-signed partial", () => {
    const d = makeTestData();
    const result = verifyPartialSignature({
      round: d.round,
      ciphertext: d.ciphertext,
      encryptedPartial: d.encryptedPartial,
      ephemeralPubKey: d.ephemeralPubKey,
      pubShare: d.pubShare,
      signature: d.signature,
      commPubKey: d.commPubKey,
    });
    expect(result).toBe(true);
  });

  it("returns false when encryptedPartial is tampered", () => {
    const d = makeTestData();
    const tampered = new Uint8Array(d.encryptedPartial);
    tampered[0] ^= 0xff;

    const result = verifyPartialSignature({
      round: d.round,
      ciphertext: d.ciphertext,
      encryptedPartial: tampered,
      ephemeralPubKey: d.ephemeralPubKey,
      pubShare: d.pubShare,
      signature: d.signature,
      commPubKey: d.commPubKey,
    });
    expect(result).toBe(false);
  });

  it("returns false when round is wrong", () => {
    const d = makeTestData();
    const result = verifyPartialSignature({
      round: d.round + 1,
      ciphertext: d.ciphertext,
      encryptedPartial: d.encryptedPartial,
      ephemeralPubKey: d.ephemeralPubKey,
      pubShare: d.pubShare,
      signature: d.signature,
      commPubKey: d.commPubKey,
    });
    expect(result).toBe(false);
  });

  it("returns false when commPubKey does not match signer", () => {
    const d = makeTestData();
    const wrongKey = secp256k1.getPublicKey(secp256k1.utils.randomPrivateKey(), false).slice(1);

    const result = verifyPartialSignature({
      round: d.round,
      ciphertext: d.ciphertext,
      encryptedPartial: d.encryptedPartial,
      ephemeralPubKey: d.ephemeralPubKey,
      pubShare: d.pubShare,
      signature: d.signature,
      commPubKey: wrongKey,
    });
    expect(result).toBe(false);
  });

  it("returns false for malformed signature (wrong length)", () => {
    const d = makeTestData();
    const result = verifyPartialSignature({
      round: d.round,
      ciphertext: d.ciphertext,
      encryptedPartial: d.encryptedPartial,
      ephemeralPubKey: d.ephemeralPubKey,
      pubShare: d.pubShare,
      signature: new Uint8Array([0x00, 0x01]),
      commPubKey: d.commPubKey,
    });
    expect(result).toBe(false);
  });

  it("handles round=0 correctly (RLP encodes as empty bytes)", () => {
    const privateKey = secp256k1.utils.randomPrivateKey();
    const commPubKey = secp256k1.getPublicKey(privateKey, false).slice(1);
    const ciphertext = new Uint8Array([0x01]);
    const encryptedPartial = new Uint8Array([0x02]);
    const ephemeralPubKey = new Uint8Array([0x03]);
    const pubShare = new Uint8Array([0x04]);

    const signature = kernelSign({
      round: 0,
      ciphertext,
      encryptedPartial,
      ephemeralPubKey,
      pubShare,
      privateKey,
    });

    const result = verifyPartialSignature({
      round: 0,
      ciphertext,
      encryptedPartial,
      ephemeralPubKey,
      pubShare,
      signature,
      commPubKey,
    });
    expect(result).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd /Users/jwpark/Work/PIPLabs/project-cdr/cdr-sdk && pnpm --filter @piplabs/cdr-crypto test -- --reporter verbose signature
```

Expected: All tests FAIL because `verifyPartialSignature` does not exist yet.

- [ ] **Step 3: Commit**

```bash
git add packages/crypto/__tests__/signature.test.ts
git commit -m "test(crypto): add failing tests for verifyPartialSignature"
```

---

### Task 3: Implement `verifyPartialSignature`

**Files:**
- Create: `packages/crypto/src/signature.ts`
- Modify: `packages/crypto/src/index.ts`

- [ ] **Step 1: Create `signature.ts`**

```typescript
import { RLP } from "@ethereumjs/rlp";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak256 as keccak256Noble } from "@noble/hashes/sha3";

/**
 * Encode a uint32 as minimal big-endian bytes, matching Go's RLP encoding of uint32.
 * - 0 → empty Uint8Array (RLP treats 0 as empty byte string)
 * - 1 → [0x01]
 * - 256 → [0x01, 0x00]
 */
function uint32ToMinimalBytes(value: number): Uint8Array {
  if (value === 0) return new Uint8Array(0);
  const buf = new Uint8Array(4);
  const view = new DataView(buf.buffer);
  view.setUint32(0, value, false);
  let start = 0;
  while (start < 3 && buf[start] === 0) start++;
  return buf.slice(start);
}

/**
 * Verify a partial decryption signature produced by the story-kernel TEE.
 *
 * Reproduces the kernel's signing protocol:
 * 1. RLP encode [Round, Ciphertext, EncryptedPartial, EphemeralPubKey, PubShare]
 * 2. Keccak256 hash the encoded bytes
 * 3. Recover the secp256k1 public key from the signature
 * 4. Compare the recovered address with the expected address derived from commPubKey
 *
 * @returns true if the signature is valid and was produced by the holder of commPubKey
 */
export function verifyPartialSignature(params: {
  round: number;
  ciphertext: Uint8Array;
  encryptedPartial: Uint8Array;
  ephemeralPubKey: Uint8Array;
  pubShare: Uint8Array;
  /** 65-byte secp256k1 signature (r || s || v), where v is 27 or 28 */
  signature: Uint8Array;
  /** 64-byte uncompressed public key (without 0x04 prefix) from DKG Registered event */
  commPubKey: Uint8Array;
}): boolean {
  const { round, ciphertext, encryptedPartial, ephemeralPubKey, pubShare, signature, commPubKey } = params;

  if (signature.length !== 65) return false;
  if (commPubKey.length !== 64) return false;

  try {
    // 1. RLP encode the signature material (matches Go struct field order)
    const roundBytes = uint32ToMinimalBytes(round);
    const encoded = RLP.encode([roundBytes, ciphertext, encryptedPartial, ephemeralPubKey, pubShare]);

    // 2. Keccak256 hash
    const respHash = keccak256Noble(encoded);

    // 3. Normalize recovery ID and recover public key
    let recoveryId = signature[64];
    if (recoveryId >= 27) recoveryId -= 27;

    const r = signature.slice(0, 32);
    const s = signature.slice(32, 64);

    const sig = new secp256k1.Signature(
      BigInt("0x" + Buffer.from(r).toString("hex")),
      BigInt("0x" + Buffer.from(s).toString("hex")),
    ).addRecoveryBit(recoveryId);

    const recoveredPubKey = sig.recoverPublicKey(respHash).toRawBytes(false);
    // recoveredPubKey is 65 bytes (0x04 || x || y), drop prefix to get 64 bytes
    const recoveredRaw = recoveredPubKey.slice(1);

    // 4. Compare addresses: keccak256(pubkey)[12:32]
    const recoveredAddr = keccak256Noble(recoveredRaw).slice(12);
    const expectedAddr = keccak256Noble(commPubKey).slice(12);

    return Buffer.from(recoveredAddr).equals(Buffer.from(expectedAddr));
  } catch {
    return false;
  }
}
```

- [ ] **Step 2: Export from index.ts**

Add this line to `packages/crypto/src/index.ts`:

```typescript
export { verifyPartialSignature } from "./signature.js";
```

- [ ] **Step 3: Run the tests to verify they pass**

```bash
cd /Users/jwpark/Work/PIPLabs/project-cdr/cdr-sdk && pnpm --filter @piplabs/cdr-crypto test -- --reporter verbose signature
```

Expected: All 6 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/crypto/src/signature.ts packages/crypto/src/index.ts
git commit -m "feat(crypto): implement verifyPartialSignature with RLP encoding"
```

---

### Task 4: Write failing tests for `Observer.getRegisteredValidators`

**Files:**
- Modify: `packages/sdk/__tests__/observer.test.ts`

- [ ] **Step 1: Add test helper and tests**

Add the following to the end of `packages/sdk/__tests__/observer.test.ts`, inside the existing `describe("Observer", ...)` block, right before the closing `});`:

First, add `encodeAbiParameters` to the existing imports (already imported), then add this helper function after the existing `makeFinalizedLog` function (before the `describe` block):

```typescript
function makeRegisteredLog(opts: {
  validatorAddr: `0x${string}`;
  enclaveCommKey: `0x${string}`;
  round: number;
}) {
  const topic0 = keccak256(
    toBytes(
      "Registered(bytes,uint32,address,bytes32,bytes,bytes,bytes32,uint256,bytes32)",
    ),
  );
  const topic1 = padHex(opts.validatorAddr, { size: 32 });

  const data = encodeAbiParameters(
    [
      { name: "enclaveReport", type: "bytes" },
      { name: "round", type: "uint32" },
      { name: "enclaveType", type: "bytes32" },
      { name: "enclaveCommKey", type: "bytes" },
      { name: "dkgPubKey", type: "bytes" },
      { name: "codeCommitment", type: "bytes32" },
      { name: "startBlockHeight", type: "uint256" },
      { name: "startBlockHash", type: "bytes32" },
    ],
    [
      "0x",
      opts.round,
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      opts.enclaveCommKey,
      "0x",
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      0n,
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    ],
  );

  return {
    address: "0xcccccc0000000000000000000000000000000004" as `0x${string}`,
    topics: [topic0, topic1] as [`0x${string}`, `0x${string}`],
    data,
    blockHash: "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`,
    blockNumber: 50n,
    transactionHash: "0x0000000000000000000000000000000000000000000000000000000000000002" as `0x${string}`,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  };
}
```

Then add these test cases inside the `describe("Observer", ...)` block:

```typescript
  it("getRegisteredValidators returns map of validator address to commPubKey", async () => {
    const client = mockPublicClient();
    const commKey = "0x" + "aa".repeat(64) as `0x${string}`; // 64 bytes
    client.getLogs.mockResolvedValueOnce([
      makeRegisteredLog({
        validatorAddr: "0x0000000000000000000000000000000000000001",
        enclaveCommKey: commKey,
        round: 1,
      }),
    ]);

    const observer = new Observer({ network: "testnet", publicClient: client });
    const validators = await observer.getRegisteredValidators();

    expect(validators.size).toBe(1);
    const key = validators.get("0x0000000000000000000000000000000000000001");
    expect(key).toBeDefined();
    expect(key!.length).toBe(64);
  });

  it("getRegisteredValidators filters by round when provided", async () => {
    const client = mockPublicClient();
    client.getLogs.mockResolvedValueOnce([
      makeRegisteredLog({
        validatorAddr: "0x0000000000000000000000000000000000000001",
        enclaveCommKey: "0x" + "aa".repeat(64) as `0x${string}`,
        round: 1,
      }),
      makeRegisteredLog({
        validatorAddr: "0x0000000000000000000000000000000000000002",
        enclaveCommKey: "0x" + "bb".repeat(64) as `0x${string}`,
        round: 2,
      }),
    ]);

    const observer = new Observer({ network: "testnet", publicClient: client });
    const validators = await observer.getRegisteredValidators({ round: 2 });

    expect(validators.size).toBe(1);
    expect(validators.has("0x0000000000000000000000000000000000000002")).toBe(true);
  });

  it("getRegisteredValidators returns empty map when no Registered events", async () => {
    const client = mockPublicClient();
    client.getLogs.mockResolvedValueOnce([]);

    const observer = new Observer({ network: "testnet", publicClient: client });
    const validators = await observer.getRegisteredValidators();

    expect(validators.size).toBe(0);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/jwpark/Work/PIPLabs/project-cdr/cdr-sdk && pnpm --filter @piplabs/cdr-sdk test -- --reporter verbose observer
```

Expected: New tests FAIL because `getRegisteredValidators` does not exist yet.

- [ ] **Step 3: Commit**

```bash
git add packages/sdk/__tests__/observer.test.ts
git commit -m "test(sdk): add failing tests for Observer.getRegisteredValidators"
```

---

### Task 5: Implement `Observer.getRegisteredValidators`

**Files:**
- Modify: `packages/sdk/src/observer.ts`

- [ ] **Step 1: Add the method**

Add the following method to the `Observer` class in `packages/sdk/src/observer.ts`, after the `getThreshold` method (before the closing `}` of the class):

```typescript
  /**
   * Get a map of validator address → enclaveCommKey from DKG Registered events.
   * The commPubKey is the 64-byte uncompressed secp256k1 public key (without 0x04 prefix)
   * used by the validator's TEE to sign partial decryption responses.
   *
   * @param round - If provided, only include validators registered for this round
   * @returns Map where keys are lowercase checksummed addresses and values are commPubKey bytes
   */
  async getRegisteredValidators(params?: {
    fromBlock?: bigint;
    round?: number;
  }): Promise<Map<string, Uint8Array>> {
    const dkgAddress = contractAddresses[this.network].dkg;
    const fromBlock = params?.fromBlock ?? BigInt(0);

    const rawLogs = await this.publicClient.getLogs({
      address: dkgAddress,
      fromBlock,
      toBlock: "latest",
    });

    const parsed = parseEventLogs({
      abi: dkgAbi,
      logs: rawLogs,
      eventName: "Registered",
    });

    const validators = new Map<string, Uint8Array>();
    for (const log of parsed) {
      if (params?.round !== undefined && log.args.round !== params.round) {
        continue;
      }
      const addr = log.args.validatorAddr.toLowerCase() as `0x${string}`;
      validators.set(addr, toBytes(log.args.enclaveCommKey));
    }

    return validators;
  }
```

- [ ] **Step 2: Run tests to verify they pass**

```bash
cd /Users/jwpark/Work/PIPLabs/project-cdr/cdr-sdk && pnpm --filter @piplabs/cdr-sdk test -- --reporter verbose observer
```

Expected: All observer tests PASS (existing + new).

- [ ] **Step 3: Commit**

```bash
git add packages/sdk/src/observer.ts
git commit -m "feat(sdk): add Observer.getRegisteredValidators for commPubKey lookup"
```

---

### Task 6: Write failing tests for signature verification in `collectPartials`

**Files:**
- Modify: `packages/sdk/__tests__/consumer.test.ts`

- [ ] **Step 1: Update the crypto mock and add test helpers**

Replace the existing `vi.mock("@piplabs/cdr-crypto", ...)` block at the top of `consumer.test.ts` with:

```typescript
vi.mock("@piplabs/cdr-crypto", () => ({
  decryptPartial: vi.fn(),
  tdh2Combine: vi.fn(),
  verifyPartialSignature: vi.fn(),
}));
```

Add this import after the existing `Consumer` import:

```typescript
import { verifyPartialSignature } from "@piplabs/cdr-crypto";
```

- [ ] **Step 2: Update `mockClients` to include DKG log responses**

The existing `mockClients` function stays the same. We need to set up the mock so that:
- `getLogs` returns `Registered` events when queried for DKG address, and `EncryptedPartialDecryptionSubmitted` events when queried for CDR address.

Add this helper after the existing `mockClients` function:

```typescript
function makeRegisteredLog(opts: {
  validatorAddr: `0x${string}`;
  enclaveCommKey: `0x${string}`;
  round: number;
}) {
  const topic0 = keccak256(
    toBytes(
      "Registered(bytes,uint32,address,bytes32,bytes,bytes,bytes32,uint256,bytes32)",
    ),
  );
  const topic1 = padHex(opts.validatorAddr, { size: 32 });

  const data = encodeAbiParameters(
    [
      { name: "enclaveReport", type: "bytes" },
      { name: "round", type: "uint32" },
      { name: "enclaveType", type: "bytes32" },
      { name: "enclaveCommKey", type: "bytes" },
      { name: "dkgPubKey", type: "bytes" },
      { name: "codeCommitment", type: "bytes32" },
      { name: "startBlockHeight", type: "uint256" },
      { name: "startBlockHash", type: "bytes32" },
    ],
    [
      "0x",
      opts.round,
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      opts.enclaveCommKey,
      "0x",
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      0n,
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    ],
  );

  return {
    address: "0xcccccc0000000000000000000000000000000004" as `0x${string}`,
    topics: [topic0, topic1] as [`0x${string}`, `0x${string}`],
    data,
    blockHash: "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`,
    blockNumber: 50n,
    transactionHash: "0x0000000000000000000000000000000000000000000000000000000000000002" as `0x${string}`,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  };
}
```

- [ ] **Step 3: Add test cases for signature verification**

Add these tests inside the `describe("Consumer", ...)` block:

```typescript
  it("collectPartials verifies signatures and accepts valid partials", async () => {
    const { publicClient, walletClient } = mockClients();
    const mockVerify = vi.mocked(verifyPartialSignature);
    mockVerify.mockReturnValue(true);

    // First getLogs call: DKG Registered events (for commPubKey map)
    // Second getLogs call: no CDR events (first poll)
    // Third getLogs call: CDR partial events
    publicClient.getBlockNumber.mockResolvedValueOnce(100n).mockResolvedValue(101n);

    // getLogs is called once for DKG Registered events, then for CDR partial events
    publicClient.getLogs
      .mockResolvedValueOnce([
        makeRegisteredLog({
          validatorAddr: "0x0000000000000000000000000000000000000001",
          enclaveCommKey: "0x" + "aa".repeat(64) as `0x${string}`,
          round: 1,
        }),
      ])
      .mockResolvedValueOnce([
        makePartialDecryptionLog({ validator: "0x0000000000000000000000000000000000000001", round: 1, pid: 1, uuid: 1 }),
      ])
      .mockResolvedValue([]);

    const consumer = new Consumer({ network: "testnet", publicClient, walletClient });
    const partials = await consumer.collectPartials({
      uuid: 1,
      minPartials: 1,
      fromBlock: 90n,
      timeoutMs: 5_000,
      pollIntervalMs: 50,
    });

    expect(partials).toHaveLength(1);
    expect(mockVerify).toHaveBeenCalledOnce();
  });

  it("collectPartials rejects invalid signatures and invokes callback", async () => {
    const { publicClient, walletClient } = mockClients();
    const mockVerify = vi.mocked(verifyPartialSignature);
    // First partial: invalid signature. Second partial: valid.
    mockVerify.mockReturnValueOnce(false).mockReturnValue(true);

    publicClient.getBlockNumber.mockResolvedValueOnce(100n).mockResolvedValue(101n);

    publicClient.getLogs
      .mockResolvedValueOnce([
        makeRegisteredLog({
          validatorAddr: "0x0000000000000000000000000000000000000001",
          enclaveCommKey: "0x" + "aa".repeat(64) as `0x${string}`,
          round: 1,
        }),
        makeRegisteredLog({
          validatorAddr: "0x0000000000000000000000000000000000000002",
          enclaveCommKey: "0x" + "bb".repeat(64) as `0x${string}`,
          round: 1,
        }),
      ])
      .mockResolvedValueOnce([
        makePartialDecryptionLog({ validator: "0x0000000000000000000000000000000000000001", round: 1, pid: 1, uuid: 1 }),
        makePartialDecryptionLog({ validator: "0x0000000000000000000000000000000000000002", round: 1, pid: 2, uuid: 1 }),
      ])
      .mockResolvedValue([]);

    const onInvalidPartial = vi.fn();
    const consumer = new Consumer({ network: "testnet", publicClient, walletClient });
    const partials = await consumer.collectPartials({
      uuid: 1,
      minPartials: 1,
      fromBlock: 90n,
      timeoutMs: 5_000,
      pollIntervalMs: 50,
      onInvalidPartial,
    });

    expect(partials).toHaveLength(1);
    expect(partials[0].pid).toBe(2); // only the valid one
    expect(onInvalidPartial).toHaveBeenCalledOnce();
    expect(onInvalidPartial.mock.calls[0][0].pid).toBe(1); // rejected partial
    expect(onInvalidPartial.mock.calls[0][1]).toBeInstanceOf(Error);
  });

  it("collectPartials skips partials from unknown validators", async () => {
    const { publicClient, walletClient } = mockClients();
    const mockVerify = vi.mocked(verifyPartialSignature);
    mockVerify.mockReturnValue(true);

    publicClient.getBlockNumber.mockResolvedValueOnce(100n).mockResolvedValue(101n);

    // No registered validators
    publicClient.getLogs
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        makePartialDecryptionLog({ validator: "0x0000000000000000000000000000000000000001", round: 1, pid: 1, uuid: 1 }),
      ])
      .mockResolvedValue([]);

    const onInvalidPartial = vi.fn();
    const consumer = new Consumer({ network: "testnet", publicClient, walletClient });

    await expect(
      consumer.collectPartials({
        uuid: 1,
        minPartials: 1,
        fromBlock: 90n,
        timeoutMs: 200,
        pollIntervalMs: 50,
        onInvalidPartial,
      }),
    ).rejects.toThrow("Timed out");

    expect(onInvalidPartial).toHaveBeenCalledOnce();
    expect(onInvalidPartial.mock.calls[0][1].message).toContain("unknown validator");
  });

  it("collectPartials silently skips invalid partials when no callback provided", async () => {
    const { publicClient, walletClient } = mockClients();
    const mockVerify = vi.mocked(verifyPartialSignature);
    mockVerify.mockReturnValueOnce(false).mockReturnValue(true);

    publicClient.getBlockNumber.mockResolvedValueOnce(100n).mockResolvedValue(101n);

    publicClient.getLogs
      .mockResolvedValueOnce([
        makeRegisteredLog({
          validatorAddr: "0x0000000000000000000000000000000000000001",
          enclaveCommKey: "0x" + "aa".repeat(64) as `0x${string}`,
          round: 1,
        }),
        makeRegisteredLog({
          validatorAddr: "0x0000000000000000000000000000000000000002",
          enclaveCommKey: "0x" + "bb".repeat(64) as `0x${string}`,
          round: 1,
        }),
      ])
      .mockResolvedValueOnce([
        makePartialDecryptionLog({ validator: "0x0000000000000000000000000000000000000001", round: 1, pid: 1, uuid: 1 }),
        makePartialDecryptionLog({ validator: "0x0000000000000000000000000000000000000002", round: 1, pid: 2, uuid: 1 }),
      ])
      .mockResolvedValue([]);

    const consumer = new Consumer({ network: "testnet", publicClient, walletClient });
    const partials = await consumer.collectPartials({
      uuid: 1,
      minPartials: 1,
      fromBlock: 90n,
      timeoutMs: 5_000,
      pollIntervalMs: 50,
      // no callback
    });

    // Should still collect valid partial without crashing
    expect(partials).toHaveLength(1);
    expect(partials[0].pid).toBe(2);
  });
```

- [ ] **Step 4: Run tests to verify they fail**

```bash
cd /Users/jwpark/Work/PIPLabs/project-cdr/cdr-sdk && pnpm --filter @piplabs/cdr-sdk test -- --reporter verbose consumer
```

Expected: New tests FAIL because `collectPartials` does not yet verify signatures.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/__tests__/consumer.test.ts
git commit -m "test(sdk): add failing tests for signature verification in collectPartials"
```

---

### Task 7: Integrate signature verification into `Consumer.collectPartials`

**Files:**
- Modify: `packages/sdk/src/consumer.ts`

- [ ] **Step 1: Add imports and Observer dependency**

Add `verifyPartialSignature` to the imports from `@piplabs/cdr-crypto`:

```typescript
import { decryptPartial as eciesDecrypt, tdh2Combine, verifyPartialSignature, type TDH2Ciphertext, type DecryptedPartial } from "@piplabs/cdr-crypto";
```

Add imports for DKG contract:

```typescript
import { cdrAbi, dkgAbi, contractAddresses, type Network } from "@piplabs/cdr-contracts";
```

Note: change the existing import from `{ cdrAbi, contractAddresses, type Network }` to include `dkgAbi`.

- [ ] **Step 2: Add Observer-like query inside Consumer**

Add a private method to the `Consumer` class for fetching the commPubKey map. This avoids creating a circular dependency or requiring the user to pass an Observer instance:

```typescript
  /** Fetch validator address → commPubKey map from DKG Registered events */
  private async getCommPubKeyMap(fromBlock?: bigint): Promise<Map<string, Uint8Array>> {
    const dkgAddress = contractAddresses[this.network].dkg;

    const rawLogs = await this.publicClient.getLogs({
      address: dkgAddress,
      fromBlock: fromBlock ?? BigInt(0),
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
```

- [ ] **Step 3: Update `collectPartials` signature and add verification logic**

Update the `collectPartials` method to accept the callback and verify signatures. Replace the entire method with:

```typescript
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
```

- [ ] **Step 4: Update `accessCDR` to pass `onInvalidPartial` through**

In the `accessCDR` method, add `onInvalidPartial` to the params type and pass it to `collectPartials`:

Update the params type to include:
```typescript
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
```

And in the `collectPartials` call inside `accessCDR`, add:
```typescript
    const partials = await this.collectPartials({
      uuid: params.uuid,
      minPartials: params.threshold,
      fromBlock,
      timeoutMs: params.timeoutMs,
      onInvalidPartial: params.onInvalidPartial,
    });
```

- [ ] **Step 5: Run all consumer tests**

```bash
cd /Users/jwpark/Work/PIPLabs/project-cdr/cdr-sdk && pnpm --filter @piplabs/cdr-sdk test -- --reporter verbose consumer
```

Expected: All consumer tests PASS, including the new signature verification tests.

Note: The existing tests that were written before signature verification may need their `getLogs` mock order adjusted. The first `getLogs` call now goes to the DKG contract for Registered events (in `getCommPubKeyMap`), so existing tests need an extra `mockResolvedValueOnce([])` prepended to their `getLogs` mock chain to handle the DKG query. If tests fail, add `publicClient.getLogs.mockResolvedValueOnce([])` as the first mock return value in each existing test — this returns an empty Registered events list, which means all validators will be "unknown" and partials will be skipped. For existing tests that don't test verification, also mock `verifyPartialSignature` to return `true` and add Registered events for each validator used.

- [ ] **Step 6: Fix any existing tests that need adjustment**

For each existing `collectPartials` test, prepend a `Registered` event mock and ensure `verifyPartialSignature` returns `true`:

At the top of each existing test that calls `collectPartials`, add:
```typescript
    vi.mocked(verifyPartialSignature).mockReturnValue(true);
```

And prepend the DKG Registered events `getLogs` mock. For example, in the "collectPartials polls until minPartials reached" test, change the `getLogs` mock chain from:
```typescript
    publicClient.getLogs
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([...])
      .mockResolvedValue([]);
```
to:
```typescript
    publicClient.getLogs
      .mockResolvedValueOnce([  // DKG Registered events
        makeRegisteredLog({ validatorAddr: "0x0000000000000000000000000000000000000001", enclaveCommKey: "0x" + "aa".repeat(64) as `0x${string}`, round: 1 }),
        makeRegisteredLog({ validatorAddr: "0x0000000000000000000000000000000000000002", enclaveCommKey: "0x" + "bb".repeat(64) as `0x${string}`, round: 1 }),
        makeRegisteredLog({ validatorAddr: "0x0000000000000000000000000000000000000003", enclaveCommKey: "0x" + "cc".repeat(64) as `0x${string}`, round: 1 }),
      ])
      .mockResolvedValueOnce([])  // first CDR poll: no events
      .mockResolvedValueOnce([...])  // second CDR poll: events
      .mockResolvedValue([]);
```

Apply this pattern to all existing `collectPartials` tests.

- [ ] **Step 7: Run all tests to verify everything passes**

```bash
cd /Users/jwpark/Work/PIPLabs/project-cdr/cdr-sdk && pnpm --filter @piplabs/cdr-sdk test -- --reporter verbose
```

Expected: All tests PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/sdk/src/consumer.ts packages/sdk/__tests__/consumer.test.ts
git commit -m "feat(sdk): integrate signature verification into collectPartials"
```

---

### Task 8: Run full test suite and verify build

**Files:** None (verification only)

- [ ] **Step 1: Run all crypto package tests**

```bash
cd /Users/jwpark/Work/PIPLabs/project-cdr/cdr-sdk && pnpm --filter @piplabs/cdr-crypto test -- --reporter verbose
```

Expected: All tests PASS.

- [ ] **Step 2: Run all SDK package tests**

```bash
cd /Users/jwpark/Work/PIPLabs/project-cdr/cdr-sdk && pnpm --filter @piplabs/cdr-sdk test -- --reporter verbose
```

Expected: All tests PASS.

- [ ] **Step 3: Build both packages**

```bash
cd /Users/jwpark/Work/PIPLabs/project-cdr/cdr-sdk && pnpm build
```

Expected: Clean build with no TypeScript errors.

- [ ] **Step 4: Run lint check**

```bash
cd /Users/jwpark/Work/PIPLabs/project-cdr/cdr-sdk && pnpm --filter @piplabs/cdr-crypto lint && pnpm --filter @piplabs/cdr-sdk lint
```

Expected: No errors.
