/**
 * Minimal protobuf wire-format primitives.
 *
 * Supports only what the x/dkg query messages need:
 *   - wire type 0 (varint): uint32, int64, bool, enum
 *   - wire type 2 (length-delimited): string, bytes, nested messages
 */

export class Writer {
  private chunks: number[] = [];

  writeVarint(n: number | bigint): this {
    let value = typeof n === "bigint" ? n : BigInt(n);
    if (value < 0n) value += 1n << 64n;
    while (value >= 0x80n) {
      this.chunks.push(Number(value & 0x7fn) | 0x80);
      value >>= 7n;
    }
    this.chunks.push(Number(value));
    return this;
  }

  writeTag(field: number, wireType: number): this {
    return this.writeVarint((field << 3) | wireType);
  }

  writeUint32(field: number, value: number): this {
    if (value === 0) return this;
    return this.writeTag(field, 0).writeVarint(value);
  }

  writeBool(field: number, value: boolean): this {
    if (!value) return this;
    return this.writeTag(field, 0).writeVarint(1);
  }

  writeString(field: number, value: string): this {
    if (value.length === 0) return this;
    const bytes = new TextEncoder().encode(value);
    return this.writeBytes(field, bytes);
  }

  writeBytes(field: number, value: Uint8Array): this {
    if (value.length === 0) return this;
    this.writeTag(field, 2).writeVarint(value.length);
    for (let i = 0; i < value.length; i++) this.chunks.push(value[i]);
    return this;
  }

  writeMessage(field: number, encoded: Uint8Array): this {
    this.writeTag(field, 2).writeVarint(encoded.length);
    for (let i = 0; i < encoded.length; i++) this.chunks.push(encoded[i]);
    return this;
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}

export class Reader {
  private offset = 0;

  constructor(private readonly buf: Uint8Array) {}

  get eof(): boolean {
    return this.offset >= this.buf.length;
  }

  readVarint(): bigint {
    let result = 0n;
    let shift = 0n;
    while (true) {
      if (this.offset >= this.buf.length) throw new Error("varint: EOF");
      const b = this.buf[this.offset++];
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result;
      shift += 7n;
      if (shift > 63n) throw new Error("varint: too long");
    }
  }

  readUint32(): number {
    return Number(this.readVarint() & 0xffffffffn);
  }

  readInt64(): bigint {
    return BigInt.asIntN(64, this.readVarint());
  }

  readBool(): boolean {
    return this.readVarint() !== 0n;
  }

  readTag(): { field: number; wireType: number } {
    const tag = Number(this.readVarint());
    return { field: tag >>> 3, wireType: tag & 0x7 };
  }

  readLenDelim(): Uint8Array {
    const len = Number(this.readVarint());
    if (this.offset + len > this.buf.length) {
      throw new Error("length-delim: out of bounds");
    }
    const out = this.buf.subarray(this.offset, this.offset + len);
    this.offset += len;
    return out;
  }

  readString(): string {
    return new TextDecoder().decode(this.readLenDelim());
  }

  skipField(wireType: number): void {
    switch (wireType) {
      case 0:
        this.readVarint();
        return;
      case 1:
        this.offset += 8;
        return;
      case 2:
        this.readLenDelim();
        return;
      case 5:
        this.offset += 4;
        return;
      default:
        throw new Error(`unsupported wire type: ${wireType}`);
    }
  }
}

export function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) {
    s += b[i].toString(16).padStart(2, "0");
  }
  return s;
}

export function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export function bytesToBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}
