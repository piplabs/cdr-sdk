import type { StorageProvider, UploadOptions } from "./types.js";

/** A function that parses a CID string into a CID object compatible with helia. */
export type CIDParser = (cid: string) => any;

/** IPFS storage provider using the Helia SDK. */
export class HeliaProvider implements StorageProvider {
  private helia: any;
  private fs: any;
  private parseCID: CIDParser;

  /**
   * @param params.helia - An initialized Helia node instance (used for pinning)
   * @param params.unixfs - A @helia/unixfs instance created from the Helia node
   * @param params.CID - CID class from the **same** `multiformats` package that
   *   helia depends on. Pass `CID` from `multiformats/cid` that is resolved in
   *   the consumer's dependency tree (typically the one helia itself uses).
   *   This avoids version-mismatch `instanceof` failures at runtime.
   *
   * @example
   * ```ts
   * import { CID } from "multiformats/cid";
   * import { createHelia } from "helia";
   * import { unixfs } from "@helia/unixfs";
   *
   * const helia = await createHelia();
   * const fs = unixfs(helia);
   * const provider = new HeliaProvider({
   *   helia,
   *   unixfs: fs,
   *   CID: (s) => CID.parse(s),
   * });
   * ```
   */
  constructor(params: { helia: any; unixfs: any; CID: CIDParser }) {
    this.helia = params.helia;
    this.fs = params.unixfs;
    this.parseCID = params.CID;
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
    // Use the caller-provided CID parser to ensure the CID object is from the
    // same multiformats version that helia uses, avoiding instanceof mismatches.
    const parsedCid = this.parseCID(cid);
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
