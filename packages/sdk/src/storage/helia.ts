import type { StorageProvider, UploadOptions } from "./types.js";

/** IPFS storage provider using the Helia SDK. */
export class HeliaProvider implements StorageProvider {
  private helia: any;
  private fs: any;

  /**
   * @param params.helia - An initialized Helia node instance (used for pinning)
   * @param params.unixfs - A @helia/unixfs instance created from the Helia node
   */
  constructor(params: { helia: any; unixfs: any }) {
    this.helia = params.helia;
    this.fs = params.unixfs;
  }

  async upload(data: Uint8Array, options?: UploadOptions): Promise<string> {
    const { pin = true } = options ?? {};
    const cid = await this.fs.addBytes(data);
    if (pin) {
      await this.helia.pins.add(cid);
    }
    return cid.toString();
  }

  async download(cid: string): Promise<Uint8Array> {
    // Pass CID string directly — Helia unixfs cat() should accept string CIDs.
    // Dynamic import of CID from multiformats can cause version mismatch with
    // helia's bundled multiformats, making instanceof checks fail.
    const chunks: Uint8Array[] = [];
    for await (const chunk of this.fs.cat(cid)) {
      chunks.push(chunk);
    }
    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }
}
