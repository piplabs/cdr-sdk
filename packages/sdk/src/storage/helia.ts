import type { StorageProvider } from "./types.js";

/** IPFS storage provider using the Helia SDK. */
export class HeliaProvider implements StorageProvider {
  private helia: any;
  private fs: any;

  /**
   * @param helia - An initialized Helia node instance
   * @param unixfs - A @helia/unixfs instance created from the Helia node
   */
  constructor(params: { helia: any; unixfs: any }) {
    this.helia = params.helia;
    this.fs = params.unixfs;
  }

  async upload(data: Uint8Array): Promise<string> {
    const cid = await this.fs.addBytes(data);
    return cid.toString();
  }

  async download(cid: string): Promise<Uint8Array> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { CID } = await import("multiformats/cid" as any);
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
