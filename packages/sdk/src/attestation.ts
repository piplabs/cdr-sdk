import { toHex } from "viem";

/** Configuration for SGX attestation verification. */
export interface AttestationConfig {
  /** Minimum acceptable security version (SVN) for the enclave. */
  minSecurityVersion?: number;
  /** Expected MRENCLAVE measurement (hex string). If set, attestation must match. */
  expectedMrEnclave?: `0x${string}`;
  /** Expected MRSIGNER measurement (hex string). If set, attestation must match. */
  expectedMrSigner?: `0x${string}`;
}

/** Result of an attestation verification. */
export interface AttestationResult {
  valid: boolean;
  securityVersion?: number;
  mrEnclave?: string;
  mrSigner?: string;
  error?: string;
}

/**
 * Intel SGX DCAP Quote v3 layout offsets.
 *
 * Reference: Intel SGX-TDX-DCAP-QuoteVerificationLibrary QuoteConstants.h
 * and piplabs/story SGXValidationHook.sol
 *
 * ```
 * Offset 0-47:    Quote Header (48 bytes)
 * Offset 48-431:  Enclave Report Body (384 bytes)
 *   Body+64:      MRENCLAVE  (32 bytes) → quote offset 112
 *   Body+128:     MRSIGNER   (32 bytes) → quote offset 176
 *   Body+256:     ISV PRODID (2 bytes)  → quote offset 304
 *   Body+258:     ISV SVN    (2 bytes)  → quote offset 306
 *   Body+320:     Report Data (64 bytes) → quote offset 368
 * Offset 432+:    Auth Data (variable)
 * ```
 */
const SGX_QUOTE_HEADER_SIZE = 48;
const SGX_REPORT_BODY_SIZE = 384;
const SGX_MIN_QUOTE_SIZE = SGX_QUOTE_HEADER_SIZE + SGX_REPORT_BODY_SIZE; // 432
const SGX_DCAP_V3_VERSION = 3; // Expected quote version (bytes 0-1, little-endian)

// Offsets from start of quote (header + offset within report body)
const MRENCLAVE_OFFSET = SGX_QUOTE_HEADER_SIZE + 64; // 112
const MRENCLAVE_SIZE = 32;
const MRSIGNER_OFFSET = SGX_QUOTE_HEADER_SIZE + 128; // 176
const MRSIGNER_SIZE = 32;
const ISV_SVN_OFFSET = SGX_QUOTE_HEADER_SIZE + 258; // 306
const ISV_SVN_SIZE = 2;

/**
 * Parse fields from an SGX DCAP Quote v3 binary.
 *
 * @param report - Raw SGX quote bytes (from DKG Registered event `enclaveReport`)
 * @returns Parsed fields: mrEnclave, mrSigner, securityVersion
 * @throws {Error} If the report is too short to be a valid SGX quote
 *
 * @example
 * ```ts
 * const fields = parseSgxQuote(enclaveReportBytes);
 * console.log(fields.mrEnclave); // "0x51c08cf3..."
 * ```
 */
export function parseSgxQuote(report: Uint8Array): {
  mrEnclave: `0x${string}`;
  mrSigner: `0x${string}`;
  securityVersion: number;
} {
  if (report.length < SGX_MIN_QUOTE_SIZE) {
    throw new Error(
      `Invalid SGX quote: ${report.length} bytes, minimum ${SGX_MIN_QUOTE_SIZE} required`,
    );
  }

  // Validate quote version (bytes 0-1, little-endian). DCAP v3 = 0x0003.
  // Quote v4 / TDX quotes have different report-body offsets and would
  // produce incorrect MRENCLAVE/MRSIGNER if parsed with v3 offsets.
  const quoteVersion = report[0] | (report[1] << 8);
  if (quoteVersion !== SGX_DCAP_V3_VERSION) {
    throw new Error(
      `Unsupported SGX quote version: ${quoteVersion} (expected ${SGX_DCAP_V3_VERSION} for DCAP v3)`,
    );
  }

  const mrEnclave = toHex(report.slice(MRENCLAVE_OFFSET, MRENCLAVE_OFFSET + MRENCLAVE_SIZE));
  const mrSigner = toHex(report.slice(MRSIGNER_OFFSET, MRSIGNER_OFFSET + MRSIGNER_SIZE));

  // ISV SVN is 2 bytes, little-endian
  const securityVersion = report[ISV_SVN_OFFSET] | (report[ISV_SVN_OFFSET + 1] << 8);

  return {
    mrEnclave: mrEnclave as `0x${string}`,
    mrSigner: mrSigner as `0x${string}`,
    securityVersion,
  };
}

/**
 * Verify an SGX attestation report against the given config.
 *
 * Parses the SGX DCAP Quote v3 binary and checks MRENCLAVE, MRSIGNER,
 * and ISV SVN against the provided configuration.
 *
 * Note: This performs client-side field verification only. The cryptographic
 * signature chain (Intel QE → PCK → root CA) is verified on-chain by
 * SGXValidationHook via Automata DCAP contracts. This function provides
 * an additional defense-in-depth check for SDK consumers.
 *
 * @param report - Raw SGX quote bytes (from DKG Registered event `enclaveReport`)
 * @param config - Verification criteria (all optional; omitted fields are not checked)
 * @returns Verification result with parsed fields and pass/fail status
 *
 * @example
 * ```ts
 * const result = await verifyAttestation(enclaveReportBytes, {
 *   expectedMrEnclave: "0x51c08cf3...",
 *   minSecurityVersion: 1,
 * });
 * if (!result.valid) console.error(result.error);
 * ```
 */
export async function verifyAttestation(
  report: Uint8Array,
  config?: AttestationConfig,
): Promise<AttestationResult> {
  if (report.length === 0) {
    return { valid: false, error: "Empty attestation report" };
  }

  let parsed;
  try {
    parsed = parseSgxQuote(report);
  } catch (e) {
    return { valid: false, error: (e as Error).message };
  }

  const result: AttestationResult = {
    valid: true,
    mrEnclave: parsed.mrEnclave,
    mrSigner: parsed.mrSigner,
    securityVersion: parsed.securityVersion,
  };

  if (config?.expectedMrEnclave !== undefined) {
    if (parsed.mrEnclave.toLowerCase() !== config.expectedMrEnclave.toLowerCase()) {
      return {
        ...result,
        valid: false,
        error: `MRENCLAVE mismatch: expected ${config.expectedMrEnclave}, got ${parsed.mrEnclave}`,
      };
    }
  }

  if (config?.expectedMrSigner !== undefined) {
    if (parsed.mrSigner.toLowerCase() !== config.expectedMrSigner.toLowerCase()) {
      return {
        ...result,
        valid: false,
        error: `MRSIGNER mismatch: expected ${config.expectedMrSigner}, got ${parsed.mrSigner}`,
      };
    }
  }

  if (config?.minSecurityVersion !== undefined) {
    if (parsed.securityVersion < config.minSecurityVersion) {
      return {
        ...result,
        valid: false,
        error: `ISV SVN ${parsed.securityVersion} < minimum ${config.minSecurityVersion}`,
      };
    }
  }

  return result;
}
