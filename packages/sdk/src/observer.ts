import { parseEventLogs, toBytes, type PublicClient } from "viem";
import { cdrAbi, dkgAbi, contractAddresses, type Network } from "@piplabs/cdr-contracts";
import type { Vault } from "./types.js";

export class Observer {
  private publicClient: PublicClient;
  private network: Network;

  constructor(params: { network: Network; publicClient: PublicClient }) {
    this.publicClient = params.publicClient;
    this.network = params.network;
  }

  /** Get a vault's details by UUID */
  async getVault(uuid: number): Promise<Vault> {
    const result = await this.publicClient.readContract({
      address: contractAddresses[this.network].cdr,
      abi: cdrAbi,
      functionName: "vaults",
      args: [uuid],
    });
    return { uuid, ...result } as unknown as Vault;
  }

  /** Get current allocation fee */
  async getAllocateFee(): Promise<bigint> {
    return this.publicClient.readContract({
      address: contractAddresses[this.network].cdr,
      abi: cdrAbi,
      functionName: "allocateFee",
    });
  }

  /** Get current write fee */
  async getWriteFee(): Promise<bigint> {
    return this.publicClient.readContract({
      address: contractAddresses[this.network].cdr,
      abi: cdrAbi,
      functionName: "writeFee",
    });
  }

  /** Get current read fee */
  async getReadFee(): Promise<bigint> {
    return this.publicClient.readContract({
      address: contractAddresses[this.network].cdr,
      abi: cdrAbi,
      functionName: "readFee",
    });
  }

  /** Get DKG operational threshold */
  async getOperationalThreshold(): Promise<bigint> {
    return this.publicClient.readContract({
      address: contractAddresses[this.network].dkg,
      abi: dkgAbi,
      functionName: "operationalThreshold",
    });
  }

  /**
   * Get the DKG global public key from the most recent Finalized event.
   * Returns the raw bytes of the globalPubKey (Ed25519 point with curve-code prefix).
   */
  async getGlobalPubKey(params?: { fromBlock?: bigint }): Promise<Uint8Array> {
    const dkgAddress = contractAddresses[this.network].dkg;
    const fromBlock = params?.fromBlock ?? 0n;

    const rawLogs = await this.publicClient.getLogs({
      address: dkgAddress,
      fromBlock,
      toBlock: "latest",
    });

    const parsed = parseEventLogs({
      abi: dkgAbi,
      logs: rawLogs,
      eventName: "Finalized",
    });

    if (parsed.length === 0) {
      throw new Error("No Finalized event found — DKG may not have completed yet");
    }

    const latest = parsed[parsed.length - 1];
    return toBytes(latest.args.globalPubKey);
  }
}
