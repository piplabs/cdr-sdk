import type { StorageProvider, UploadOptions } from "./types.js";

/** A function that parses a CID string into a CID object compatible with helia. */
export type CIDParser = (cid: string) => any;

/** IPFS storage provider using the Helia SDK. */
export class HeliaProvider implements StorageProvider {
  private helia: any;
  private fs: any;
  private parseCID?: CIDParser;

  /**
   * @param params.helia - An initialized Helia node instance (used for pinning)
   * @param params.unixfs - A @helia/unixfs instance created from the Helia node
   * @param params.CID - (Recommended) CID parser from the **same** `multiformats`
   *   package that helia depends on. Avoids version-mismatch `instanceof` failures.
   *   If omitted, falls back to dynamic `import("multiformats/cid")` which may
   *   fail if multiple multiformats versions are installed.
   *
   * @example
   * ```ts
   * import { CID } from "multiformats/cid";
   * const provider = new HeliaProvider({
   *   helia,
   *   unixfs: fs,
   *   CID: (s) => CID.parse(s),
   * });
   * ```
   */
  constructor(params: { helia: any; unixfs: any; CID?: CIDParser }) {
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
    // Use the caller-provided CID parser when available (recommended).
    // Fall back to dynamic import for backward compatibility.
    let parsedCid: any;
    if (this.parseCID) {
      parsedCid = this.parseCID(cid);
    } else {
      const { CID } = await import("multiformats/cid");
      parsedCid = CID.parse(cid);
    }
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
