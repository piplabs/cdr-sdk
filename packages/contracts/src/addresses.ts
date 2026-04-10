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

export const conditionAddresses: Partial<Record<Network, { fixedFee: `0x${string}`; whitelist: `0x${string}`; timeBased: `0x${string}` }>> = {
  testnet: {
    fixedFee: "0x44863F234b137A395e5c98359d16057A9A1fAc55",
    whitelist: "0x0c03eCB91Cb50835e560a7D52190EB1a5ffba797",
    timeBased: "0x1c39BA375faB6a9f6E0c01B9F49d488e101C2011",
  },
};
