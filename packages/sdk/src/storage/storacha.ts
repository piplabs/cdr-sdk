import type { StorageProvider } from "./types.js";

/** Storage provider using Storacha (w3up) SDK. */
export class StorachaProvider implements StorageProvider {
  private client: any;

  /**
   * @param client - A configured @storacha/client instance (with space set)
   */
  constructor(client: any) {
    this.client = client;
  }

  async upload(data: Uint8Array): Promise<string> {
    const buf = new ArrayBuffer(data.byteLength);
    new Uint8Array(buf).set(data);
    const blob = new Blob([buf]);
    const cid = await this.client.uploadFile(blob);
    return cid.toString();
  }

  async download(cid: string): Promise<Uint8Array> {
    const response = await fetch(`https://w3s.link/ipfs/${cid}`);
    if (!response.ok) {
      throw new Error(`Storacha download failed: ${response.status} ${response.statusText}`);
    }
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }
}
