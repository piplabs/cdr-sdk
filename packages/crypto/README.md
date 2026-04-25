# @piplabs/cdr-crypto

Cryptographic primitives for the CDR (Confidential Data Rails) protocol on Story L1: TDH2 threshold encryption (via WASM), ECIES partial decryption, validator partial-signature verification, and file encryption.

This package is a building block for [`@piplabs/cdr-sdk`](https://www.npmjs.com/package/@piplabs/cdr-sdk). Most users should install the SDK instead — it re-exports everything from this package.

## Install

```sh
npm install @piplabs/cdr-crypto
```

## Exports

- `tdh2Encrypt`, `tdh2Verify`, `tdh2Combine`, `tdh2ExtractLabel` — TDH2 threshold encryption (implementation in WASM)
- `decryptPartial`, `generateEphemeralKeyPair` — ECIES helpers used to receive partial decryptions
- `verifyPartialSignature` — secp256k1 ECDSA verification of a validator's partial-decryption signature (RLP encode the response fields, keccak256, recover, address compare against `commPubKey`)
- `encryptFile`, `decryptFile` — AES-256-GCM single-pass file encryption (`Uint8Array` in / `Uint8Array` out, ciphertext format: `IV || encrypted || GCM tag`)
- `initWasm`, `resetWasm`, `getWasm`, `setWasmForTesting`, `CURVE_ED25519` — WASM module lifecycle (must call `initWasm()` once before any TDH2 op)

## WASM bundle

The TDH2 implementation is compiled to `cb-mpc-tdh2.wasm` shipped in `dist/wasm/`. Bundlers must be able to copy or fetch this file at runtime.

## License

MIT — see [LICENSE](./LICENSE).
