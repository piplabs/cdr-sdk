import { describe, it, expect } from "vitest";
import { parseSgxQuote, verifyAttestation } from "../src/attestation.js";
import { AttestationQuoteError } from "../src/errors.js";

const SGX_MIN_QUOTE_SIZE = 432;
const MRENCLAVE_OFFSET = 112;
const MRSIGNER_OFFSET = 176;
const ISV_SVN_OFFSET = 306;

/**
 * Build a mock SGX DCAP Quote v3 binary with known values at the right offsets.
 *
 * @param opts.mrEnclave - 32-byte value placed at offset 112 (default: 0xAA repeated)
 * @param opts.mrSigner  - 32-byte value placed at offset 176 (default: 0xBB repeated)
 * @param opts.svn       - ISV SVN as a 16-bit LE value at offset 306 (default: 1)
 * @param opts.size      - Total buffer size (default: 432, the minimum)
 */
function buildMockQuote(opts?: {
  mrEnclave?: Uint8Array;
  mrSigner?: Uint8Array;
  svn?: number;
  size?: number;
}): Uint8Array {
  const size = opts?.size ?? SGX_MIN_QUOTE_SIZE;
  const buf = new Uint8Array(size);

  // Set quote version to 3 (DCAP v3) — bytes 0-1 little-endian
  buf[0] = 3;
  buf[1] = 0;

  // Fill MRENCLAVE (32 bytes at offset 112)
  const mrEnclave = opts?.mrEnclave ?? new Uint8Array(32).fill(0xaa);
  buf.set(mrEnclave, MRENCLAVE_OFFSET);

  // Fill MRSIGNER (32 bytes at offset 176)
  const mrSigner = opts?.mrSigner ?? new Uint8Array(32).fill(0xbb);
  buf.set(mrSigner, MRSIGNER_OFFSET);

  // Fill ISV SVN (2 bytes little-endian at offset 306)
  const svn = opts?.svn ?? 1;
  buf[ISV_SVN_OFFSET] = svn & 0xff;
  buf[ISV_SVN_OFFSET + 1] = (svn >> 8) & 0xff;

  return buf;
}

describe("parseSgxQuote", () => {
  it("extracts correct MRENCLAVE (32 bytes at offset 112)", () => {
    const mrEnclaveBytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) mrEnclaveBytes[i] = i;
    const quote = buildMockQuote({ mrEnclave: mrEnclaveBytes });
    const result = parseSgxQuote(quote);

    // viem toHex produces lowercase hex with 0x prefix
    const expectedHex =
      "0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
    expect(result.mrEnclave).toBe(expectedHex);
  });

  it("extracts correct MRSIGNER (32 bytes at offset 176)", () => {
    const mrSignerBytes = new Uint8Array(32).fill(0xcc);
    const quote = buildMockQuote({ mrSigner: mrSignerBytes });
    const result = parseSgxQuote(quote);

    expect(result.mrSigner).toBe("0x" + "cc".repeat(32));
  });

  it("extracts correct ISV SVN (little-endian at offset 306), svn=3", () => {
    const quote = buildMockQuote({ svn: 3 });
    const result = parseSgxQuote(quote);
    expect(result.securityVersion).toBe(3);
  });

  it("SVN > 255 works (svn=257 = 0x0101 LE)", () => {
    const quote = buildMockQuote({ svn: 257 });
    const result = parseSgxQuote(quote);
    expect(result.securityVersion).toBe(257);
  });

  it("throws for 431 bytes (one byte short)", () => {
    const quote = new Uint8Array(431);
    expect(() => parseSgxQuote(quote)).toThrow(
      "Invalid SGX quote: 431 bytes, minimum 432 required",
    );
    expect(() => parseSgxQuote(quote)).toThrow(AttestationQuoteError);
  });

  it("works for exactly 432 bytes (boundary)", () => {
    const quote = buildMockQuote({ size: 432 });
    const result = parseSgxQuote(quote);
    expect(result.mrEnclave).toBeDefined();
    expect(result.mrSigner).toBeDefined();
    expect(result.securityVersion).toBeDefined();
  });

  it("works for 5000 bytes (oversized, like real quotes ~4734 bytes)", () => {
    const quote = buildMockQuote({ size: 5000, svn: 42 });
    const result = parseSgxQuote(quote);
    expect(result.securityVersion).toBe(42);
  });
});

describe("verifyAttestation", () => {
  it("empty report returns { valid: false, error containing 'Empty attestation report' }", async () => {
    const result = await verifyAttestation(new Uint8Array(0));
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Empty attestation report");
  });

  it("no config returns { valid: true } with all fields populated", async () => {
    const quote = buildMockQuote();
    const result = await verifyAttestation(quote);
    expect(result.valid).toBe(true);
    expect(result.mrEnclave).toBeDefined();
    expect(result.mrSigner).toBeDefined();
    expect(result.securityVersion).toBeDefined();
    expect(result.error).toBeUndefined();
  });

  it("matching expectedMrEnclave returns valid: true", async () => {
    const mrEnclaveBytes = new Uint8Array(32).fill(0xdd);
    const quote = buildMockQuote({ mrEnclave: mrEnclaveBytes });
    const expectedHex = ("0x" + "dd".repeat(32)) as `0x${string}`;
    const result = await verifyAttestation(quote, {
      expectedMrEnclave: expectedHex,
    });
    expect(result.valid).toBe(true);
  });

  it("mismatching expectedMrEnclave returns valid: false with MRENCLAVE mismatch", async () => {
    const quote = buildMockQuote({ mrEnclave: new Uint8Array(32).fill(0xdd) });
    const wrongHex = ("0x" + "ee".repeat(32)) as `0x${string}`;
    const result = await verifyAttestation(quote, {
      expectedMrEnclave: wrongHex,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("MRENCLAVE mismatch");
  });

  it("mismatching expectedMrSigner returns valid: false with MRSIGNER mismatch", async () => {
    const quote = buildMockQuote({ mrSigner: new Uint8Array(32).fill(0xbb) });
    const wrongHex = ("0x" + "ff".repeat(32)) as `0x${string}`;
    const result = await verifyAttestation(quote, {
      expectedMrSigner: wrongHex,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("MRSIGNER mismatch");
  });

  it("SVN too low returns valid: false with ISV SVN error", async () => {
    const quote = buildMockQuote({ svn: 2 });
    const result = await verifyAttestation(quote, {
      minSecurityVersion: 5,
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("ISV SVN");
  });

  it("case-insensitive comparison: uppercase config vs lowercase parsed returns valid: true", async () => {
    const mrEnclaveBytes = new Uint8Array(32).fill(0xab);
    const quote = buildMockQuote({ mrEnclave: mrEnclaveBytes });
    // parseSgxQuote uses viem toHex which returns lowercase
    // Provide uppercase in config to test case-insensitive comparison
    const upperHex = ("0x" + "AB".repeat(32)) as `0x${string}`;
    const result = await verifyAttestation(quote, {
      expectedMrEnclave: upperHex,
    });
    expect(result.valid).toBe(true);
  });
});
