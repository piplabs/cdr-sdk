import type { StorageProvider } from "./types.js";

/**
 * Filecoin storage provider using the Synapse SDK.
 *
 * Note: the string returned from `upload` and accepted by `download` is a
 * Filecoin PieceCID, not an IPFS CID. It is only resolvable by another
 * SynapseProvider pointed at the same network.
 */
export class SynapseProvider implements StorageProvider {
  private synapse: any;

  /**
   * @param synapse - An instance created via `Synapse.create({ chain, transport, account })`
   *                  from `@filoz/synapse-sdk`.
   */
  constructor(synapse: any) {
    this.synapse = synapse;
  }

  async upload(data: Uint8Array): Promise<string> {
    const result = await this.synapse.storage.upload(data);
    return result.pieceCid.toString();
  }

  async download(pieceCid: string): Promise<Uint8Array> {
    const data = await this.synapse.storage.download({ pieceCid });
    return new Uint8Array(data);
  }
}
