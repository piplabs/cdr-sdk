/** Generic storage provider interface for uploading/downloading files by CID. */
export interface StorageProvider {
  /** Upload bytes to storage, returns a CID string. */
  upload(data: Uint8Array): Promise<string>;
  /** Download bytes from storage by CID. */
  download(cid: string): Promise<Uint8Array>;
}
