import type { StorageProvider, UploadOptions } from "./types.js";

/**
 * IPFS storage provider using the Helia SDK.
 *
 * @example
 * ```ts
 * import { createHelia } from "helia";
 * import { unixfs } from "@helia/unixfs";
 * import { CID } from "multiformats/cid";
 *
 * const helia = await createHelia();
 * const fs = unixfs(helia);
 * const provider = new HeliaProvider({ helia, unixfs: fs, CID });
 * ```
 */
export class HeliaProvider implements StorageProvider {
  private helia: any;
  private fs: any;
  private cidClass: any;

  /**
   * @param params.helia - An initialized Helia node instance (used for pinning)
   * @param params.unixfs - A @helia/unixfs instance created from the Helia node
   * @param params.CID - The CID class from the same multiformats package used by Helia.
   *   This avoids CID class mismatch when the SDK and Helia resolve multiformats
   *   from different locations. If not provided, falls back to dynamic import.
   */
  constructor(params: { helia: any; unixfs: any; CID?: any }) {
    this.helia = params.helia;
    this.fs = params.unixfs;
    this.cidClass = params.CID;
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
    // Use caller-provided CID class to ensure compatibility with Helia's
    // internal multiformats version. Falls back to dynamic import if not provided.
    let CIDClass = this.cidClass;
    if (!CIDClass) {
      const mod = await import("multiformats/cid");
      CIDClass = mod.CID;
    }
    const parsedCid = CIDClass.parse(cid);

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
