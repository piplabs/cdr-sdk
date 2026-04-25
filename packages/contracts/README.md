# @piplabs/cdr-contracts

ABIs, deployment addresses, and the `Network` type for the CDR (Confidential Data Rails) contracts on Story L1.

This package is a building block for [`@piplabs/cdr-sdk`](https://www.npmjs.com/package/@piplabs/cdr-sdk). Most users should install the SDK instead — it re-exports everything from this package.

## Install

```sh
npm install @piplabs/cdr-contracts viem
```

## Exports

- `cdrAbi`, `dkgAbi` — viem-compatible ABIs
- `contractAddresses` — `{ mainnet: { dkg, cdr }, testnet: { dkg, cdr } }`
- `type Network` — `"mainnet" | "testnet"`
- `getCDRContract`, `getDKGContract` — viem `getContract` helpers

## Usage

```ts
import { cdrAbi, contractAddresses } from "@piplabs/cdr-contracts";
import { createPublicClient, http } from "viem";

const client = createPublicClient({ transport: http("https://aeneid.storyrpc.io") });
const fee = await client.readContract({
  address: contractAddresses.testnet.cdr,
  abi: cdrAbi,
  functionName: "readFee",
});
```

## License

MIT — see [LICENSE](./LICENSE).
