import type { StorageProvider, UploadOptions } from "./types.js";

/** Generic IPFS HTTP API + gateway provider. */
export class GatewayProvider implements StorageProvider {
  private apiUrl: string;
  private gatewayUrl: string;

  /**
   * @param params.apiUrl - IPFS HTTP API endpoint (e.g. "http://localhost:5001")
   * @param params.gatewayUrl - IPFS gateway base URL (e.g. "https://gateway.pinata.cloud/ipfs")
   */
  constructor(params: { apiUrl: string; gatewayUrl: string }) {
    this.apiUrl = params.apiUrl.replace(/\/+$/, "");
    this.gatewayUrl = params.gatewayUrl.replace(/\/+$/, "");
  }

  async upload(data: Uint8Array, options?: UploadOptions): Promise<string> {
    const { pin = true } = options ?? {};
    const formData = new FormData();
    const buf = new ArrayBuffer(data.byteLength);
    new Uint8Array(buf).set(data);
    formData.append("file", new Blob([buf]));

    const response = await fetch(`${this.apiUrl}/api/v0/add`, {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`IPFS API upload failed: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();
    const cid = result.Hash;

    if (pin) {
      const pinResponse = await fetch(`${this.apiUrl}/api/v0/pin/add?arg=${cid}`, {
        method: "POST",
      });
      if (!pinResponse.ok) {
        throw new Error(`IPFS pin failed: ${pinResponse.status} ${pinResponse.statusText}`);
      }
    }

    return cid;
  }

  async download(cid: string): Promise<Uint8Array> {
    const response = await fetch(`${this.gatewayUrl}/${cid}`);
    if (!response.ok) {
      throw new Error(`IPFS gateway download failed: ${response.status} ${response.statusText}`);
    }
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }
}
