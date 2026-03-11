import { getContract, type GetContractReturnType, type PublicClient, type WalletClient, type Client } from "viem";
import { dkgAbi } from "./abis/dkg.js";
import { cdrAbi } from "./abis/cdr.js";
import { contractAddresses, type Network } from "./addresses.js";

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

export type DKGContract = ReturnType<typeof getDKGContract>;
export type CDRContract = ReturnType<typeof getCDRContract>;
