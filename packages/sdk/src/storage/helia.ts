import type { StorageProvider } from "./types.js";

/** IPFS storage provider using the Helia SDK. */
export class HeliaProvider implements StorageProvider {
  private fs: any;

  /**
   * @param params.unixfs - A @helia/unixfs instance created from the Helia node
   */
  constructor(params: { unixfs: any }) {
    this.fs = params.unixfs;
  }

  async upload(data: Uint8Array): Promise<string> {
    const cid = await this.fs.addBytes(data);
    return cid.toString();
  }

  async download(cid: string): Promise<Uint8Array> {
    const { CID } = await import("multiformats/cid");
    const parsedCid = CID.parse(cid);
    const chunks: Uint8Array[] = [];
    for await (const chunk of this.fs.cat(parsedCid)) {
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
