import type { StorageProvider } from "./types.js";

/** Filecoin storage provider using the Synapse SDK. */
export class SynapseProvider implements StorageProvider {
  private client: any;

  /**
   * @param client - A configured @filoz/synapse-sdk client instance
   */
  constructor(client: any) {
    this.client = client;
  }

  async upload(data: Uint8Array): Promise<string> {
    const result = await this.client.upload(data);
    return result.cid.toString();
  }

  async download(cid: string): Promise<Uint8Array> {
    const data = await this.client.download(cid);
    return new Uint8Array(data);
  }
}
