# Partial Decryption Signature Verification

**Date:** 2026-03-26
**Status:** Approved

## Problem

The story-kernel signs partial decryption responses using RLP-encoded material + Keccak256 + secp256k1. The SDK collects `EncryptedPartialDecryptionSubmitted` events but never verifies these signatures. Consumers have no way to detect tampered partial decryptions before combining them.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Where to verify | Inside `collectPartials` | Secure by default; invalid partials never reach callers |
| CommPubKey resolution | Query DKG `Registered` events | Self-contained; future: replace with indexed endpoint |
| Failure handling | Skip invalid + optional callback | Resilient to bad validators; caller controls logging |
| Callback shape | `onInvalidPartial?: (event, error) => void` | SDK stays quiet by default; consumer decides |
| Code location | `@piplabs/cdr-crypto` | Crypto logic centralized with ECIES/TDH2 |
| RLP library | `@ethereumjs/rlp` | Lightweight, well-maintained, no full geth dep |

## Kernel Signing Protocol

Source: `story-kernel/service/dkg_partial_decrypt.go` (`signPartialDecryptResponse`)

```go
type partialDecryptSignatureMaterial struct {
    Round            uint32
    Ciphertext       []byte
    EncryptedPartial []byte
    EphemeralPubKey  []byte
    PubShare         []byte
}
// 1. RLP encode the struct
// 2. Keccak256 hash the encoded bytes
// 3. secp256k1 sign the hash
// 4. If recovery ID < 27, add 27
```

## New Components

### 1. `packages/crypto/src/signature.ts`

```typescript
export function verifyPartialSignature(params: {
  round: number;
  ciphertext: Uint8Array;
  encryptedPartial: Uint8Array;
  ephemeralPubKey: Uint8Array;
  pubShare: Uint8Array;
  signature: Uint8Array;    // 65 bytes (r || s || v)
  commPubKey: Uint8Array;   // 64 bytes (uncompressed, no 0x04 prefix)
}): boolean
```

Implementation:
1. Encode `round` as 4-byte big-endian `Uint8Array`
2. RLP encode: `RLP.encode([roundBytes, ciphertext, encryptedPartial, ephemeralPubKey, pubShare])`
   - Go's `rlp.EncodeToBytes(struct)` encodes a struct as an RLP list of its fields in order
   - `uint32` is encoded as an integer (no leading zeros, empty byte string for 0)
   - `[]byte` fields are encoded as RLP byte strings
3. `respHash = keccak256(encoded)`
4. Normalize signature: if `v >= 27`, subtract 27
5. Recover public key from `(respHash, signature)` using secp256k1
6. Compare: `keccak256(recoveredPubKey) === keccak256(commPubKey)` (address derivation)
7. Return `true` if match, `false` otherwise

Note on RLP encoding of `uint32`: Go's RLP encoder treats `uint32` as an integer, encoding it with minimal bytes (no leading zeros). For example, round=1 encodes as `[0x01]`, round=256 as `[0x01, 0x00]`, round=0 as `[]` (empty byte string). The JS implementation must match this behavior, NOT encode it as a fixed 4-byte big-endian value.

Dependencies:
- `@ethereumjs/rlp` — RLP encoding
- `viem` — `keccak256` (already a peer dep)
- `@noble/curves/secp256k1` — `ecrecover` equivalent (already in package)

### 2. `packages/crypto/src/index.ts`

Export the new function:
```typescript
export { verifyPartialSignature } from "./signature.js";
```

### 3. `packages/sdk/src/observer.ts` — new method

```typescript
async getRegisteredValidators(params?: {
  fromBlock?: bigint;
  round?: number;
}): Promise<Map<string, Uint8Array>>
```

- Queries `Registered` events from DKG contract
- If `round` is provided, filters to that round only
- Returns `Map<lowercaseAddress, enclaveCommKey as Uint8Array>`
- `enclaveCommKey` from the event is 64 bytes (raw x,y coordinates, no 0x04 prefix)

### 4. `packages/sdk/src/consumer.ts` — changes

**`collectPartials` new parameter:**
```typescript
async collectPartials(params: {
  uuid: number;
  minPartials: number;
  fromBlock: bigint;
  timeoutMs?: number;
  pollIntervalMs?: number;
  onInvalidPartial?: (event: PartialDecryptionEvent, error: Error) => void;
}): Promise<PartialDecryptionEvent[]>
```

**New internal behavior:**
1. At the start of `collectPartials`, call `observer.getRegisteredValidators()` to build the commPubKey map
2. For each parsed `EncryptedPartialDecryptionSubmitted` event:
   a. Look up `commPubKey` for the event's `validator` address
   b. If not found, treat as invalid (unknown validator)
   c. Call `verifyPartialSignature(...)` with the event fields and commPubKey
   d. If verification fails, call `onInvalidPartial(event, error)` and skip
   e. If verification passes, add to collected set
3. Consumer needs access to an Observer instance — add it as a private field, constructed from the same `publicClient` and `network`

**`accessCDR` changes:**
- The `onInvalidPartial` callback needs to be passable through `accessCDR` as well:
```typescript
async accessCDR(params: {
  // ... existing params ...
  onInvalidPartial?: (event: PartialDecryptionEvent, error: Error) => void;
}): Promise<{ dataKey: Uint8Array; txHash: `0x${string}` }>
```

## File Changes Summary

| File | Change |
|------|--------|
| `packages/crypto/src/signature.ts` | New file: `verifyPartialSignature()` |
| `packages/crypto/src/index.ts` | Add export |
| `packages/crypto/package.json` | Add `@ethereumjs/rlp` dependency |
| `packages/sdk/src/observer.ts` | Add `getRegisteredValidators()` method |
| `packages/sdk/src/consumer.ts` | Integrate verification into `collectPartials` and `accessCDR` |
| `packages/crypto/__tests__/signature.test.ts` | New: unit tests |
| `packages/sdk/__tests__/consumer.test.ts` | Update: verification in collect flow |

## Test Plan

### Unit: `verifyPartialSignature`
- Reproduce kernel signing in JS (RLP encode + keccak256 + secp256k1 sign), verify it passes
- Tampered `encryptedPartial` (flip a byte) → returns false
- Tampered `round` → returns false
- Wrong `commPubKey` → returns false
- Malformed signature (wrong length) → returns false or throws

### Unit: `collectPartials` with verification
- Mock events with valid signatures → all collected
- Mix of valid and invalid signatures → only valid ones collected, callback invoked for invalid
- No callback provided + invalid signature → silently skipped (no crash)
- Unknown validator (not in Registered events) → skipped, callback invoked

### Unit: `getRegisteredValidators`
- Returns correct map from mock Registered events
- Filters by round when provided
