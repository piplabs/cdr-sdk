import type { PublicClient, WalletClient } from "viem";
import type { Network } from "@piplabs/cdr-contracts";
import { Uploader } from "./uploader.js";
import { Consumer } from "./consumer.js";
import { Observer } from "./observer.js";
import { WalletClientRequiredError } from "./errors.js";

export class CDRClient {
  public readonly observer: Observer;
  private _uploader: Uploader | null;
  private _consumer: Consumer | null;

  constructor(params: {
    network: Network;
    publicClient: PublicClient;
    walletClient?: WalletClient;
  }) {
    const { network, publicClient, walletClient } = params;

    this.observer = new Observer({ network, publicClient });

    if (walletClient) {
      this._uploader = new Uploader({ network, publicClient, walletClient });
      this._consumer = new Consumer({ network, publicClient, walletClient });
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
