/**
 * Optional logger surface for the SDK. Pass a `CDRLogger` into `CDRClient`
 * to observe structured events (`registry.prefetch.start`,
 * `partial.accepted`, `read.preflight.insufficient_balance`, etc.).
 *
 * Defaults to {@link noopLogger} — zero behavior change for callers that
 * don't supply one. The SDK never logs sensitive material (private keys,
 * decrypted bytes, data keys, file contents); contexts carry only
 * identifiers, counts, reasons, and decimal-string amounts.
 */
export interface CDRLogger {
  debug(message: string, ctx?: Record<string, unknown>): void;
  info(message: string, ctx?: Record<string, unknown>): void;
  warn(message: string, ctx?: Record<string, unknown>): void;
  error(message: string, ctx?: Record<string, unknown>): void;
}

export const noopLogger: CDRLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/** Stable error-message extractor — used for `{ reason }` log fields without leaking stack frames. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    const json = JSON.stringify(err);
    return json ?? String(err);
  } catch {
    return String(err);
  }
}
