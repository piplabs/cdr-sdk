# @piplabs/cdr-crypto

Cryptographic primitives for the CDR (Confidential Data Rails) protocol on Story L1: TDH2 threshold encryption, ECIES partial decryption, partial-signature verification, and AEAD file encryption.

This package is a building block for [`@piplabs/cdr-sdk`](https://www.npmjs.com/package/@piplabs/cdr-sdk). Most users should install the SDK instead — it re-exports everything from this package.

## Install

```sh
npm install @piplabs/cdr-crypto
```

## Exports

- `tdh2Encrypt`, `tdh2Verify`, `tdh2Combine`, `tdh2ExtractLabel` — threshold ElGamal (TDH2)
- `decryptPartial`, `generateEphemeralKeyPair` — ECIES helpers used to receive partial decryptions
- `verifyPartialSignature` — Ed25519 signature check on a validator partial
- `encryptFile`, `decryptFile` — AES-GCM streaming file encryption keyed by a TDH2-protected data key
- `initWasm`, `resetWasm`, `getWasm`, `setWasmForTesting`, `CURVE_ED25519` — WASM module lifecycle (must call `initWasm()` once before any TDH2 op)

## WASM bundle

The TDH2 implementation is compiled to a `cb-mpc-tdh2.wasm` shipped in `dist/wasm/`. Bundlers must be able to copy or fetch this file at runtime. See the SDK README for environment-specific setup notes.

## License

MIT — see [LICENSE](./LICENSE).
