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
 * Verify an SGX attestation report against the given config.
 *
 * @experimental This function is not yet implemented. It will parse the SGX DCAP
 * quote format (header 48 bytes + report body 384 bytes + auth data) and verify
 * MRENCLAVE, MRSIGNER, and ISV SVN against the provided config.
 *
 * See SGXValidationHook.sol in piplabs/story for the on-chain verification reference.
 *
 * @throws {Error} Always throws until SGX attestation verification is implemented.
 */
export async function verifyAttestation(
  _report: Uint8Array,
  _config?: AttestationConfig,
): Promise<AttestationResult> {
  throw new Error(
    "SGX attestation verification is not yet implemented. " +
    "Track progress: https://github.com/piplabs/cdr-sdk/issues — attestation implementation.",
  );
}
