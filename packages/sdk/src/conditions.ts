import { encodeAbiParameters } from "viem";

/** Condition configuration for a CDR vault read/write gate. */
export interface ConditionConfig {
  /** Address of the condition contract (or zero address for open access). */
  address: `0x${string}`;
  /** ABI-encoded condition data passed to the condition contract. */
  conditionData: `0x${string}`;
}

/** No-restriction condition — anyone can access. */
function open(params: { address: `0x${string}` }): ConditionConfig {
  return { address: params.address, conditionData: "0x" };
}

/** Only the specified owner can access. */
function ownerOnly(params: {
  address: `0x${string}`;
  owner: `0x${string}`;
}): ConditionConfig {
  return {
    address: params.address,
    conditionData: encodeAbiParameters(
      [{ type: "address" }],
      [params.owner],
    ),
  };
}

/** Token-gated access — caller must hold at least `minBalance` of `token`. */
function tokenGate(params: {
  address: `0x${string}`;
  token: `0x${string}`;
  minBalance: bigint;
}): ConditionConfig {
  return {
    address: params.address,
    conditionData: encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [params.token, params.minBalance],
    ),
  };
}

/** Merkle-proof gated access — caller must prove inclusion in the tree. */
function merkle(params: {
  address: `0x${string}`;
  root: `0x${string}`;
}): ConditionConfig {
  return {
    address: params.address,
    conditionData: encodeAbiParameters(
      [{ type: "bytes32" }],
      [params.root],
    ),
  };
}

/** Pass-through for custom condition contracts with pre-encoded data. */
function custom(params: {
  address: `0x${string}`;
  conditionData: `0x${string}`;
}): ConditionConfig {
  return { address: params.address, conditionData: params.conditionData };
}

export const conditions = { open, ownerOnly, tokenGate, merkle, custom } as const;
