/**
 * Error-path integration tests — coverage for cases that the per-class
 * suites (consumer / uploader / observer) don't naturally cover.
 *
 * Migrated from story-cdr-e2e/cdr-sdk-tests/src/errors.test.ts. The
 * original wrapped construction via a `setup.ts` shim; here we use the
 * live env + viem clients directly so the file is self-contained.
 *
 * Audit of ERR-01..ERR-06 against existing suites at migration time:
 *
 *   ERR-01 (uploader getter w/o walletClient → WalletClientRequiredError)
 *     — not covered elsewhere; this file owns it.
 *   ERR-02 (consumer getter w/o walletClient → WalletClientRequiredError)
 *     — not covered elsewhere; this file owns it.
 *   ERR-03 (accessCDR with non-existent uuid rejects)
 *     — covered by `consumer.test.ts`'s
 *       "collectPartials throws EmptyVaultError fast when the uuid has
 *        no vault data" (faster + more specific via EmptyVaultError).
 *   ERR-04 (accessCDR with tiny timeout → PartialCollectionTimeoutError)
 *     — covered by `consumer.test.ts`'s
 *       "collectPartials throws PartialCollectionTimeoutError when no
 *        read tx is in flight".
 *   ERR-05 (write to non-existent uuid reverts)
 *     — not covered elsewhere; this file owns it.
 *   ERR-06 (allocate with invalid condition addr → InvalidConditionContractError)
 *     — covered by `uploader.test.ts`'s "default policy rejects EOA as
 *       writeConditionAddr / readConditionAddr".
 */

import { describe, it, expect } from "vitest";
import {
  type PublicClient,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  CDRClient,
  WalletClientRequiredError,
} from "../src/index.js";

const API_URL = process.env.CDR_API_URL;
const RPC_URL = process.env.CDR_RPC_URL;
const PRIVATE_KEY = process.env.CDR_TEST_PRIVATE_KEY as
  | `0x${string}`
  | undefined;

if (!API_URL) throw new Error("CDR_API_URL is not set");
if (!RPC_URL) throw new Error("CDR_RPC_URL is not set");
if (!PRIVATE_KEY) throw new Error("CDR_TEST_PRIVATE_KEY is not set");

function makeReadOnlyClient(): CDRClient {
  const publicClient = createPublicClient({
    transport: http(RPC_URL),
  }) as unknown as PublicClient;
  return new CDRClient({
    network: "testnet",
    publicClient,
    apiUrl: API_URL!,
  });
}

function makeFullClient(): {
  client: CDRClient;
  publicClient: PublicClient;
  walletClient: WalletClient;
} {
  const account = privateKeyToAccount(PRIVATE_KEY!);
  const publicClient = createPublicClient({
    transport: http(RPC_URL),
  }) as unknown as PublicClient;
  const walletClient = createWalletClient({
    account,
    transport: http(RPC_URL),
  }) as unknown as WalletClient;
  const client = new CDRClient({
    network: "testnet",
    publicClient,
    walletClient,
    apiUrl: API_URL!,
  });
  return { client, publicClient, walletClient };
}

describe(`Error-path integration tests (live: ${API_URL})`, () => {
  it("ERR-01: accessing uploader without walletClient throws WalletClientRequiredError", () => {
    const cdr = makeReadOnlyClient();
    expect(() => cdr.uploader).toThrow(WalletClientRequiredError);
  });

  it("ERR-02: accessing consumer without walletClient throws WalletClientRequiredError", () => {
    const cdr = makeReadOnlyClient();
    expect(() => cdr.consumer).toThrow(WalletClientRequiredError);
  });

  // 30s timeout — observed 1534ms (chain tx + revert). Default 5s is
  // technically enough today but leaves no headroom on a busy chain.
  it("ERR-05: write() to a non-existent uuid reverts", { timeout: 30_000 }, async () => {
    const { client } = makeFullClient();
    // uuid=999_999 is well past any reasonable vault counter — the CDR
    // contract's vault-data check will revert before any condition logic.
    await expect(
      client.uploader.write({
        uuid: 999_999,
        accessAuxData: "0x",
        encryptedData: "0x1234",
      }),
    ).rejects.toThrow();
  });
});
