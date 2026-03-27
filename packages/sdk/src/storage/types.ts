/** Options for StorageProvider.upload */
export interface UploadOptions {
  /** Pin the file for permanent storage. Defaults to true. */
  pin?: boolean;
}

/** Generic storage provider interface for uploading/downloading files by CID. */
export interface StorageProvider {
  /** Upload bytes to storage, returns a CID string. */
  upload(data: Uint8Array, options?: UploadOptions): Promise<string>;
  /** Download bytes from storage by CID. */
  download(cid: string): Promise<Uint8Array>;
}
