import { type PublicClient, type WalletClient, createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CDRClient, type Network } from "@piplabs/cdr-sdk";

const DEFAULT_RPC_URLS: Record<Network, string> = {
  mainnet: "https://rpc.story.foundation",
  testnet: "https://aeneid.storyrpc.io",
};

export interface GlobalOptions {
  network: Network;
  rpcUrl?: string;
  privateKey?: string;
  json: boolean;
}

export function createClient(opts: GlobalOptions): CDRClient {
  const rpcUrl = opts.rpcUrl ?? DEFAULT_RPC_URLS[opts.network];

  const publicClient = createPublicClient({ transport: http(rpcUrl) }) as PublicClient;

  let walletClient;
  const pk = opts.privateKey ?? process.env.CDR_PRIVATE_KEY;
  if (pk) {
    const account = privateKeyToAccount(pk as `0x${string}`);
    walletClient = createWalletClient({ account, transport: http(rpcUrl) }) as WalletClient;
  }

  return new CDRClient({ network: opts.network, publicClient, walletClient });
}

export function output(data: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(data, replacer, 2));
  } else if (typeof data === "string") {
    console.log(data);
  } else {
    console.log(data);
  }
}

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  return value;
}
