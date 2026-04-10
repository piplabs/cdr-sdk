import { createPublicClient, http, type PublicClient, type WalletClient } from "viem";
import type { Network } from "@piplabs/cdr-contracts";
import { Uploader } from "./uploader.js";
import { Consumer } from "./consumer.js";
import { Observer } from "./observer.js";
import { ConditionManager } from "./conditionManager.js";
import { WalletClientRequiredError } from "./errors.js";

export class CDRClient {
  public readonly observer: Observer;
  private _uploader: Uploader | null;
  private _consumer: Consumer | null;
  private _conditions: ConditionManager | null;

  constructor(params: {
    network: Network;
    publicClient: PublicClient;
    walletClient?: WalletClient;
    /** Minimum threshold ratio override (0-1). The effective threshold is max(contract threshold, ceil(participants * minThresholdRatio)). */
    minThresholdRatio?: number;
    /** Additional RPC URLs for cross-validating critical on-chain reads (e.g., DKG global public key). */
    validationRpcUrls?: string[];
  }) {
    const { network, publicClient, walletClient } = params;

    const validationClients = params.validationRpcUrls?.map(url =>
      createPublicClient({ transport: http(url) }),
    );

    this.observer = new Observer({
      network,
      publicClient,
      minThresholdRatio: params.minThresholdRatio,
      validationClients,
    });

    if (walletClient) {
      this._uploader = new Uploader({ network, publicClient, walletClient });
      this._consumer = new Consumer({ network, publicClient, walletClient, observer: this.observer });
      this._conditions = new ConditionManager({ network, publicClient, walletClient });
    } else {
      this._uploader = null;
      this._consumer = null;
      this._conditions = null;
    }
  }

  /** Access the uploader. Throws WalletClientRequiredError if no wallet was provided. */
  get uploader(): Uploader {
    if (!this._uploader) throw new WalletClientRequiredError();
    return this._uploader;
  }

  /** Access the consumer. Throws WalletClientRequiredError if no wallet was provided. */
  get consumer(): Consumer {
    if (!this._consumer) throw new WalletClientRequiredError();
    return this._consumer;
  }

  /** Access the condition manager. Throws WalletClientRequiredError if no wallet was provided. */
  get conditions(): ConditionManager {
    if (!this._conditions) throw new WalletClientRequiredError();
    return this._conditions;
  }
}
