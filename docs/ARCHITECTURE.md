# Architecture

How CDR works end-to-end, from key generation to data recovery.

## System Overview

CDR (Confidential Data Recovery) lets you encrypt data so that no single party can decrypt it. Instead, a threshold of validators must cooperate to recover the original data. This is built on two on-chain systems:

- **DKG (Distributed Key Generation)** — Validators run a protocol inside secure enclaves to jointly produce a **global public key**. No single validator knows the corresponding private key. Each validator holds a **key share**.
- **CDR (Confidential Data Recovery)** — On-chain vaults store TDH2-encrypted data. When a read is authorized, validators each produce a **partial decryption** using their key share. A threshold of partials can be combined to recover the plaintext.

## The Full Flow

```
                          ┌──────────────────┐
                          │  DKG Contract     │
                          │                   │
                          │  globalPubKey      │
                          │  threshold         │
                          │  participants      │
                          └────────┬──────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              │                    │                     │
              ▼                    ▼                     ▼
        ┌──────────┐       ┌──────────────┐     ┌──────────────┐
        │ ENCRYPT  │       │   STORE      │     │   RECOVER    │
        │          │       │              │     │              │
        │ TDH2     │──────▶│  CDR Vault   │────▶│  Threshold   │
        │ encrypt  │       │  on-chain    │     │  decrypt     │
        └──────────┘       └──────────────┘     └──────────────┘
```

### Phase 1: Encrypt and Upload

1. **Fetch the global public key** from the DKG contract's `Finalized` events.
2. **Generate a data key** (random 32 bytes). This is what you encrypt — you use it separately to encrypt your actual payload (files, messages, etc.) with standard symmetric encryption.
3. **Allocate a vault** on the CDR contract. This gives you a UUID and registers your access control conditions (who can write, who can read).
4. **Derive a label** from the UUID (28 zero bytes + 4-byte big-endian UUID). The label ties the ciphertext to this specific vault so validators can verify it.
5. **TDH2-encrypt the data key** to the global public key with the label.
6. **Write the ciphertext** to the vault.

```
dataKey (32 bytes)
    │
    ▼
TDH2.encrypt(dataKey, globalPubKey, label)
    │
    ▼
ciphertext ──▶ CDR contract (vault.encryptedData)
```

### Phase 2: Request Access

7. **Derive your secp256k1 public key** from your private key. Validators encrypt their partial decryptions *to you* using ECIES, so only you can read them.
8. **Submit a read request** to the CDR contract. This emits a `VaultRead` event containing the vault's ciphertext and your public key.
9. Validators watching the chain see the `VaultRead` event. Each validator that holds a DKG key share:
   - Computes a partial decryption of the ciphertext using their share
   - ECIES-encrypts the partial to your public key
   - Submits the encrypted partial back on-chain via `submitEncryptedPartialDecryption`

### Phase 3: Collect and Decrypt

10. **Poll for `EncryptedPartialDecryptionSubmitted` events** until you have at least `threshold` partials.
11. **ECIES-decrypt each partial** using your private key. The protocol is ECDH (secp256k1) + HKDF-SHA256 + AES-256-GCM with info string `"dkg-tdh2-partial"`.
12. **TDH2-combine the decrypted partials** to recover the original data key. This is a threshold operation — you need exactly `threshold` valid partials, not all of them.

```
EncryptedPartial₁ ──ECIES──▶ Partial₁ ─┐
EncryptedPartial₂ ──ECIES──▶ Partial₂ ─┤
EncryptedPartial₃ ──ECIES──▶ Partial₃ ─┤
         ...                            │
                                        ▼
                              TDH2.combine(partials, threshold, globalPubKey, ciphertext, label)
                                        │
                                        ▼
                                    dataKey (recovered)
```

## Cryptographic Primitives

### TDH2 (Threshold Data Hiding v2)

- **Curve:** Ed25519
- **Implementation:** WASM module (`cb-mpc-tdh2.wasm`) compiled from C++
- **Key format:** 34 bytes — 2-byte curve-code prefix (`0x043f` for Ed25519) + 32-byte point. The DKG contract stores raw 32-byte points; the SDK adds the prefix automatically.
- **Label:** 32-byte value derived from vault UUID. Binds ciphertext to a specific vault.
- **Ciphertext:** Variable-length serialized blob containing encrypted data, NIZK proofs, and metadata. Stored as-is on-chain.
- **Threshold:** `ceil(participantCount * operationalThreshold / 1000)`. The `operationalThreshold` is a parts-per-thousand value set on the DKG contract.

### ECIES (Elliptic Curve Integrated Encryption Scheme)

Used for the validator-to-requester encrypted channel:

1. Validator generates an ephemeral secp256k1 keypair
2. ECDH shared secret = ephemeralPrivKey * requesterPubKey
3. AES key = HKDF-SHA256(sharedSecret, info=`"dkg-tdh2-partial"`) → 32 bytes
4. Encrypted partial = AES-256-GCM(partial, nonce) → `nonce || ciphertext || tag`
5. On-chain: `(encryptedPartial, ephemeralPubKey)` posted as event data
6. Requester reverses with their private key: ECDH shared secret = requesterPrivKey * ephemeralPubKey

## On-Chain Contracts

### DKG Contract (`0xcccccc...0004`)

Manages the distributed key generation protocol.

**Key state:**
- `operationalThreshold` — Parts-per-thousand threshold value
- `Finalized` events — Each validator posts their round results (global pub key, public coefficients, key share)

**Lifecycle:**
1. Validators register with their enclave attestation
2. Validators run the DKG protocol off-chain inside secure enclaves
3. Each validator calls `finalize()` with their result and the shared global public key
4. The most recent `Finalized` event's `globalPubKey` is the current encryption target

### CDR Contract (`0xcccccc...0005`)

Manages encrypted data vaults.

**Key state:**
- `vaults` mapping (UUID → Vault struct)
- `uuid` counter (auto-increments on allocate)
- Fee parameters: `allocateFee`, `writeFee`, `readFee`, `baseFee`

**Events in the data flow:**
1. `VaultAllocated` — New vault created, contains UUID and condition addresses
2. `VaultWritten` — Encrypted data written to vault
3. `VaultRead` — Read requested, triggers validators to produce partials
4. `EncryptedPartialDecryptionSubmitted` — Validator posted their encrypted partial

## Package Structure

```
@piplabs/cdr-sdk          CDRClient, Observer, Uploader, Consumer
    │
    ├── @piplabs/cdr-contracts    ABIs, addresses, Network type
    │
    └── @piplabs/cdr-crypto       TDH2 (WASM), ECIES, constants
```

- **`@piplabs/cdr-contracts`** is pure data — ABIs and addresses. No runtime dependencies.
- **`@piplabs/cdr-crypto`** bundles the WASM module and wraps it with typed functions. Also implements ECIES using `@noble/curves` and `@noble/ciphers`.
- **`@piplabs/cdr-sdk`** ties everything together with viem-based contract interactions. It depends on both sub-packages.

## Security Model

- **Threshold trust:** No single validator can decrypt. An attacker needs to compromise `threshold` validators simultaneously.
- **Enclave attestation:** DKG participants prove they're running approved code in a secure enclave before joining.
- **On-chain access control:** Vaults enforce write/read conditions via pluggable condition contracts checked at the protocol level.
- **End-to-end encryption of partials:** Validators encrypt their partial decryptions to the requester's public key using ECIES. Other observers of the chain cannot decrypt them.
- **Label binding:** The label (derived from vault UUID) is baked into the TDH2 ciphertext. A ciphertext cannot be moved to a different vault — the combine step would fail.
