/**
 * Derive a deterministic 32-byte TDH2 label from a vault UUID.
 * Matches the Go validator's uuidToLabel(): 28 zero bytes + 4-byte big-endian UUID.
 */
export function uuidToLabel(uuid: number): Uint8Array {
  const label = new Uint8Array(32);
  const view = new DataView(label.buffer);
  view.setUint32(28, uuid, false); // big-endian
  return label;
}
