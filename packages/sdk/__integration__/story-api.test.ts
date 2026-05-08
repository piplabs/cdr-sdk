/**
 * Integration tests for the Story-API REST client against a live endpoint.
 *
 * Run all integration tests (from monorepo root or packages/sdk):
 *   pnpm test:integration
 *
 * Run only this file (from packages/sdk):
 *   pnpm test:integration story-api
 *
 * Run a specific test case (from packages/sdk):
 *   pnpm test:integration story-api -t "queryCDRPartials"
 *
 * Override URL:
 *   CDR_API_URL=http://<host>:1317 pnpm test:integration
 *
 * Scope: read-only verification that REST responses decode into the
 * expected TypeScript shapes. Positive cases that require state bootstrap
 * (e.g. a non-empty `queryCDRPartials` response, which needs an uploaded
 * vault + a `read()` tx + waiting for validator partial submissions) are
 * intentionally out of scope here — they will live in sibling test files
 * under this `__integration__/` directory once the bootstrap helpers are
 * built. This file stays focused on REST shape verification only.
 */

import { describe, it, expect } from "vitest";
import { generateEphemeralKeyPair } from "@piplabs/cdr-crypto";
import {
  queryLatestActiveDKGNetwork,
  queryDKGNetwork,
  queryGlobalPubKey,
  queryAllRegistrations,
  queryVerifiedRegistrations,
  queryCDRPartials,
  bytesToHex,
} from "../src/story-api/index.js";
import { logCase } from "./_helpers.js";

const API_URL = process.env.CDR_API_URL;
if (!API_URL) {
  throw new Error(
    "CDR_API_URL is not set. Configure it in .env.local (see .env.local.example).",
  );
}

describe(`story-api integration tests (live: ${API_URL})`, () => {
  it("queryLatestActiveDKGNetwork returns current network state", async () => {
    const network = await queryLatestActiveDKGNetwork({ apiUrl: API_URL });
    logCase("queryLatestActiveDKGNetwork", network);

    expect(network.round).toBeGreaterThanOrEqual(1);
    expect(network.threshold).toBeGreaterThan(0);
    expect(network.total).toBeGreaterThan(0);
    expect(network.threshold).toBeLessThanOrEqual(network.total);

    expect(network.globalPublicKey).toBeInstanceOf(Uint8Array);
    expect(network.globalPublicKey.length).toBe(32);

    expect(network.startBlockHash).toBeInstanceOf(Uint8Array);
    expect(network.startBlockHash.length).toBe(32);

    expect(typeof network.startBlockHeight).toBe("bigint");
    expect(network.startBlockHeight).toBeGreaterThan(0n);

    expect(network.activeValSet.length).toBeGreaterThan(0);
    for (const addr of network.activeValSet) {
      expect(addr).toMatch(/^0x[0-9a-f]{40}$/);
    }

    expect(network.publicCoeffs.length).toBe(network.threshold);
    for (const c of network.publicCoeffs) {
      expect(c).toBeInstanceOf(Uint8Array);
      expect(c.length).toBeGreaterThan(0);
    }
  });

  it("queryDKGNetwork(currentRound) returns the same network as latest_active", async () => {
    const cur = await queryLatestActiveDKGNetwork({ apiUrl: API_URL });
    const network = await queryDKGNetwork({ apiUrl: API_URL, round: cur.round });
    logCase(`queryDKGNetwork(round=${cur.round})`, network);

    expect(network.round).toBe(cur.round);
    expect(network.total).toBe(cur.total);
    expect(network.threshold).toBe(cur.threshold);
    expect(Array.from(network.globalPublicKey)).toEqual(Array.from(cur.globalPublicKey));
  });

  it("queryGlobalPubKey returns a 32-byte key matching latest_active", async () => {
    const [key, network] = await Promise.all([
      queryGlobalPubKey({ apiUrl: API_URL }),
      queryLatestActiveDKGNetwork({ apiUrl: API_URL }),
    ]);
    logCase("queryGlobalPubKey", key);

    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(32);
    // Both endpoints expose the same value, in different encodings
    // (hex vs base64). Decoded bytes must match.
    expect(Array.from(key)).toEqual(Array.from(network.globalPublicKey));
  });

  it("queryAllRegistrations(currentRound) returns the round's full registration set", async () => {
    const cur = await queryLatestActiveDKGNetwork({ apiUrl: API_URL });
    const regs = await queryAllRegistrations({ apiUrl: API_URL, round: cur.round });
    logCase(`queryAllRegistrations(round=${cur.round}) count=${regs.length}`, regs);

    expect(regs.length).toBe(cur.total);
    for (const r of regs) {
      expect(r.round).toBe(cur.round);
      expect(r.validatorAddr).toMatch(/^0x[0-9a-f]{40}$/);
      expect(r.commPubKey).toBeInstanceOf(Uint8Array);
      expect(r.commPubKey.length).toBeGreaterThan(0);
      expect(r.dkgPubKey).toBeInstanceOf(Uint8Array);
      expect(r.dkgPubKey.length).toBeGreaterThan(0);
      // Active rounds → all registrations should be Finalized (status 2).
      expect([1, 2]).toContain(r.status);
    }

    // pids should be unique within a round
    const pids = regs.map((r) => r.index);
    expect(new Set(pids).size).toBe(pids.length);
  });

  it("queryVerifiedRegistrations on an Active round returns empty (entries are Finalized)", async () => {
    const cur = await queryLatestActiveDKGNetwork({ apiUrl: API_URL });
    const verified = await queryVerifiedRegistrations({ apiUrl: API_URL, round: cur.round });
    logCase(`queryVerifiedRegistrations(round=${cur.round})`, verified);

    expect(verified).toEqual([]);
  });

  // TODO: piplabs/story currently surfaces ALL backend errors (keeper +
  // validate) as HTTP 500 — see piplabs/story#804 README and
  // `client/server/utils/wrap.go`. Once gRPC→HTTP mapping is in:
  //   - `codes.NotFound` should be 404 (drop the try/catch in
  //     `expectEmptyOrNotFound`; queryCDRPartials resolves to [] directly)
  //   - `validate()` errors should be 400 (no behavior change for the
  //     malformed-key test below — still throws, just with status 400
  //     instead of 500, which also stops the SDK's 5xx retry loop)

  /** Wrap a "should be empty" call that today throws keeper NotFound on miss. */
  async function expectEmptyOrNotFound(
    label: string,
    fn: () => Promise<unknown[]>,
  ): Promise<void> {
    let result: unknown[] = [];
    try {
      result = await fn();
    } catch (err) {
      expect((err as Error).message).toContain("code = NotFound");
    }
    logCase(label, result);
    expect(result).toEqual([]);
  }

  it("queryCDRPartials returns empty when the uuid does not exist", async () => {
    // Real valid uncompressed secp256k1 pubkey — passes server-side
    // length / shape validation; the keeper miss is what we exercise.
    const realPubKey = bytesToHex(generateEphemeralKeyPair().publicKey);
    await expectEmptyOrNotFound(
      "queryCDRPartials(real pubkey, non-existent uuid)",
      () =>
        queryCDRPartials({
          apiUrl: API_URL,
          uuid: 999_999_999,
          requesterPubKeyHex: realPubKey,
        }),
    );
  });

  it("queryCDRPartials rejects malformed requesterPubKey (wrong length)", async () => {
    // 32 bytes instead of 65 — fails the length check in
    // `getCDRPartialsRequest.validate()` before reaching the keeper.
    const malformedPubKey = "04" + "00".repeat(31);
    await expect(
      queryCDRPartials({
        apiUrl: API_URL,
        uuid: 1,
        requesterPubKeyHex: malformedPubKey,
      }),
    ).rejects.toThrow(/65 bytes/);
  });

  it("queryAllRegistrations on a non-existent round returns empty", async () => {
    const result = await queryAllRegistrations({ apiUrl: API_URL, round: 999_999 });
    logCase("queryAllRegistrations(round=999999)", result);

    expect(result).toEqual([]);
  });
});
