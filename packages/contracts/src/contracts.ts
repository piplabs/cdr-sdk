import { getContract, type GetContractReturnType, type PublicClient, type WalletClient, type Client } from "viem";
import { dkgAbi } from "./abis/dkg.js";
import { cdrAbi } from "./abis/cdr.js";
import { fixedFeeConditionAbi } from "./abis/fixedFeeCondition.js";
import { whitelistConditionAbi } from "./abis/whitelistCondition.js";
import { timeBasedConditionAbi } from "./abis/timeBasedCondition.js";
import { contractAddresses, conditionAddresses, type Network } from "./addresses.js";

function buildClient(publicClient?: PublicClient, walletClient?: WalletClient): Client {
  if (publicClient && walletClient) {
    return { public: publicClient, wallet: walletClient } as unknown as Client;
  }
  if (publicClient) {
    return publicClient as unknown as Client;
  }
  if (walletClient) {
    return walletClient as unknown as Client;
  }
  throw new Error("At least one of publicClient or walletClient must be provided");
}

export function getDKGContract(params: {
  network: Network;
  publicClient?: PublicClient;
  walletClient?: WalletClient;
}) {
  return getContract({
    address: contractAddresses[params.network].dkg,
    abi: dkgAbi,
    client: buildClient(params.publicClient, params.walletClient),
  });
}

export function getCDRContract(params: {
  network: Network;
  publicClient?: PublicClient;
  walletClient?: WalletClient;
}) {
  return getContract({
    address: contractAddresses[params.network].cdr,
    abi: cdrAbi,
    client: buildClient(params.publicClient, params.walletClient),
  });
}

export function getFixedFeeConditionContract(params: {
  network: Network;
  publicClient?: PublicClient;
  walletClient?: WalletClient;
}) {
  const addresses = conditionAddresses[params.network];
  if (!addresses) {
    throw new Error(`Condition contracts are not available on network "${params.network}"`);
  }
  return getContract({
    address: addresses.fixedFee,
    abi: fixedFeeConditionAbi,
    client: buildClient(params.publicClient, params.walletClient),
  });
}

export function getWhitelistConditionContract(params: {
  network: Network;
  publicClient?: PublicClient;
  walletClient?: WalletClient;
}) {
  const addresses = conditionAddresses[params.network];
  if (!addresses) {
    throw new Error(`Condition contracts are not available on network "${params.network}"`);
  }
  return getContract({
    address: addresses.whitelist,
    abi: whitelistConditionAbi,
    client: buildClient(params.publicClient, params.walletClient),
  });
}

export function getTimeBasedConditionContract(params: {
  network: Network;
  publicClient?: PublicClient;
  walletClient?: WalletClient;
}) {
  const addresses = conditionAddresses[params.network];
  if (!addresses) {
    throw new Error(`Condition contracts are not available on network "${params.network}"`);
  }
  return getContract({
    address: addresses.timeBased,
    abi: timeBasedConditionAbi,
    client: buildClient(params.publicClient, params.walletClient),
  });
}

export type DKGContract = ReturnType<typeof getDKGContract>;
export type CDRContract = ReturnType<typeof getCDRContract>;
export type FixedFeeConditionContract = ReturnType<typeof getFixedFeeConditionContract>;
export type WhitelistConditionContract = ReturnType<typeof getWhitelistConditionContract>;
export type TimeBasedConditionContract = ReturnType<typeof getTimeBasedConditionContract>;
