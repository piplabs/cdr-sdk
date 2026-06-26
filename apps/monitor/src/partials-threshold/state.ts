import { readFile, writeFile } from "node:fs/promises";

/**
 * A decrypt request seen via a CDR `VaultRead` log and not yet resolved.
 * `block`/`deadline` are EL block numbers; `round`/`threshold` are captured
 * from the active DKG network at ingest so a zero-partial expiry can still be
 * judged against the right threshold (the keeper returns no group to read it
 * from when nothing was submitted).
 */
export interface PendingRequest {
  uuid: number;
  /** Requester uncompressed pubkey, 0x-hex (the bytes the CDR `read()` carried). */
  requesterPubKeyHex: string;
  /** TDH2 ciphertext, 0x-hex lowercase. */
  ciphertextHex: string;
  /** EL block the VaultRead was emitted at. */
  block: number;
  /** block + DECRYPT_TIMEOUT_BLOCKS — request is expired once head passes this. */
  deadline: number;
  /** Active DKG round at ingest. */
  round: number;
  /** Active threshold at ingest (fallback for the zero-partial case). */
  threshold: number;
}

export interface ReadRequestsState {
  /** Highest EL block already scanned for VaultRead logs; null on first run. */
  lastScannedBlock: number | null;
  requests: PendingRequest[];
}

export const EMPTY_STATE: ReadRequestsState = { lastScannedBlock: null, requests: [] };

/** Load state, tolerating an absent or malformed file by returning empty state. */
export async function loadState(path: string): Promise<ReadRequestsState> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { ...EMPTY_STATE };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ReadRequestsState>;
    if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed.requests)) {
      return { ...EMPTY_STATE };
    }
    return {
      lastScannedBlock:
        typeof parsed.lastScannedBlock === "number" ? parsed.lastScannedBlock : null,
      requests: parsed.requests as PendingRequest[],
    };
  } catch {
    return { ...EMPTY_STATE };
  }
}

export async function saveState(path: string, state: ReadRequestsState): Promise<void> {
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
