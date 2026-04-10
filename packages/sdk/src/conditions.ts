import { encodeAbiParameters } from "viem";
import { conditionAddresses, type Network } from "@piplabs/cdr-contracts";

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

/** FixedFee condition — requires payment to access. */
function fixedFee(params: { network: Network }): ConditionConfig {
  const addresses = conditionAddresses[params.network];
  if (!addresses) {
    throw new Error(`Condition contracts are not available on network "${params.network}"`);
  }
  return { address: addresses.fixedFee, conditionData: "0x" };
}

/** Whitelist condition — only whitelisted addresses can access. */
function whitelist(params: { network: Network }): ConditionConfig {
  const addresses = conditionAddresses[params.network];
  if (!addresses) {
    throw new Error(`Condition contracts are not available on network "${params.network}"`);
  }
  return { address: addresses.whitelist, conditionData: "0x" };
}

/** TimeBased condition — access restricted to a time window. */
function timeBased(params: { network: Network }): ConditionConfig {
  const addresses = conditionAddresses[params.network];
  if (!addresses) {
    throw new Error(`Condition contracts are not available on network "${params.network}"`);
  }
  return { address: addresses.timeBased, conditionData: "0x" };
}

export const conditions = { open, ownerOnly, tokenGate, merkle, custom, fixedFee, whitelist, timeBased } as const;
