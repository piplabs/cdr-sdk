import type { PublicClient, WalletClient } from "viem";
import {
  type Network,
  conditionAddresses,
  fixedFeeConditionAbi,
  whitelistConditionAbi,
  timeBasedConditionAbi,
} from "@piplabs/cdr-contracts";

export class ConditionManager {
  private network: Network;
  private publicClient: PublicClient;
  private walletClient: WalletClient;

  constructor(params: {
    network: Network;
    publicClient: PublicClient;
    walletClient: WalletClient;
  }) {
    this.network = params.network;
    this.publicClient = params.publicClient;
    this.walletClient = params.walletClient;
  }

  private getConditionAddresses() {
    const addresses = conditionAddresses[this.network];
    if (!addresses) {
      throw new Error(`Condition contracts are not available on network "${this.network}"`);
    }
    return addresses;
  }

  // ── FixedFee ──────────────────────────────────────────────────────────

  /** Register a vault with a fixed fee requirement. */
  async registerFixedFee(params: { uuid: number; fee: bigint }): Promise<`0x${string}`> {
    const addresses = this.getConditionAddresses();
    return this.walletClient.writeContract({
      chain: this.walletClient.chain ?? null,
      account: this.walletClient.account ?? null,
      address: addresses.fixedFee,
      abi: fixedFeeConditionAbi,
      functionName: "register",
      args: [params.uuid, params.fee],
    });
  }

  /** Pay the fee for a vault to gain access. */
  async payFee(params: { uuid: number; fee: bigint }): Promise<`0x${string}`> {
    const addresses = this.getConditionAddresses();
    return this.walletClient.writeContract({
      chain: this.walletClient.chain ?? null,
      account: this.walletClient.account ?? null,
      address: addresses.fixedFee,
      abi: fixedFeeConditionAbi,
      functionName: "payFee",
      args: [params.uuid],
      value: params.fee,
    });
  }

  /** Withdraw accumulated fees as a vault creator. */
  async withdrawFees(): Promise<`0x${string}`> {
    const addresses = this.getConditionAddresses();
    return this.walletClient.writeContract({
      chain: this.walletClient.chain ?? null,
      account: this.walletClient.account ?? null,
      address: addresses.fixedFee,
      abi: fixedFeeConditionAbi,
      functionName: "withdraw",
      args: [],
    });
  }

  // ── Whitelist ─────────────────────────────────────────────────────────

  /** Register a vault with whitelist-based access control. */
  async registerWhitelist(params: { uuid: number }): Promise<`0x${string}`> {
    const addresses = this.getConditionAddresses();
    return this.walletClient.writeContract({
      chain: this.walletClient.chain ?? null,
      account: this.walletClient.account ?? null,
      address: addresses.whitelist,
      abi: whitelistConditionAbi,
      functionName: "register",
      args: [params.uuid],
    });
  }

  /** Add an account to a vault's whitelist. */
  async addToWhitelist(params: { uuid: number; account: `0x${string}` }): Promise<`0x${string}`> {
    const addresses = this.getConditionAddresses();
    return this.walletClient.writeContract({
      chain: this.walletClient.chain ?? null,
      account: this.walletClient.account ?? null,
      address: addresses.whitelist,
      abi: whitelistConditionAbi,
      functionName: "addToWhitelist",
      args: [params.uuid, params.account],
    });
  }

  /** Remove an account from a vault's whitelist. */
  async removeFromWhitelist(params: { uuid: number; account: `0x${string}` }): Promise<`0x${string}`> {
    const addresses = this.getConditionAddresses();
    return this.walletClient.writeContract({
      chain: this.walletClient.chain ?? null,
      account: this.walletClient.account ?? null,
      address: addresses.whitelist,
      abi: whitelistConditionAbi,
      functionName: "removeFromWhitelist",
      args: [params.uuid, params.account],
    });
  }

  // ── TimeBased ─────────────────────────────────────────────────────────

  /** Register a vault with time-based access control. */
  async registerTimeBased(params: { uuid: number; startTime: bigint; endTime: bigint }): Promise<`0x${string}`> {
    const addresses = this.getConditionAddresses();
    return this.walletClient.writeContract({
      chain: this.walletClient.chain ?? null,
      account: this.walletClient.account ?? null,
      address: addresses.timeBased,
      abi: timeBasedConditionAbi,
      functionName: "register",
      args: [params.uuid, params.startTime, params.endTime],
    });
  }
}
