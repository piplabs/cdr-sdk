import type { Network } from "@piplabs/cdr-contracts";
import { Uploader } from "./uploader.js";
import { Consumer } from "./consumer.js";
import { Observer } from "./observer.js";
import type { CDRPublicClient, CDRWalletClient } from "./client-types.js";
import { type CDRLogger, noopLogger } from "./logger.js";
import { WalletClientRequiredError } from "./errors.js";

export class CDRClient {
  public readonly observer: Observer;
  private _uploader: Uploader | null;
  private _consumer: Consumer | null;

  constructor(params: {
    network: Network;
    publicClient: CDRPublicClient;
    walletClient?: CDRWalletClient;
    /** Story-API REST base URL, e.g. `"http://node:1317"`. */
    apiUrl: string;
    /** Minimum threshold ratio override (0-1). The effective threshold is max(source threshold, ceil(participants * minThresholdRatio)). */
    minThresholdRatio?: number;
    /** Optional structured logger; defaults to a no-op. See {@link CDRLogger}. */
    logger?: CDRLogger;
  }) {
    const { network, publicClient, walletClient, apiUrl } = params;
    const logger = params.logger ?? noopLogger;

    this.observer = new Observer({
      network,
      publicClient,
      apiUrl,
      minThresholdRatio: params.minThresholdRatio,
      logger,
    });

    if (walletClient) {
      this._uploader = new Uploader({
        network,
        publicClient,
        walletClient,
        observer: this.observer,
        logger,
      });
      this._consumer = new Consumer({
        network,
        publicClient,
        walletClient,
        observer: this.observer,
        apiUrl,
        logger,
      });
    } else {
      this._uploader = null;
      this._consumer = null;
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
}
