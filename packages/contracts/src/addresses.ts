export const contractAddresses = {
  mainnet: {
    dkg: "0xcccccc0000000000000000000000000000000004",
    cdr: "0xcccccc0000000000000000000000000000000005",
  },
  testnet: {
    dkg: "0xcccccc0000000000000000000000000000000004",
    cdr: "0xcccccc0000000000000000000000000000000005",
  },
} as const satisfies Record<string, Record<string, `0x${string}`>>;

export type Network = "mainnet" | "testnet";
