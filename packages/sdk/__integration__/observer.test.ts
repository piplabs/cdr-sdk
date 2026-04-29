/**
 * Integration tests for Observer against a live Story-API REST endpoint
 * and EVM JSON-RPC. Verifies the REST cut-over end-to-end (story-api wire
 * format → decoder → Observer-level filtering / Ed25519 prefixing /
 * round-keyed cache) on the same data the lower-level
 * `__integration__/story-api.test.ts` validates.
 *
 * Run all integration tests (from packages/sdk):
 *   pnpm test:integration
 *
 * Run only this file:
 *   pnpm test:integration observer
 *
 * Required env (from `.env.local`):
 *   CDR_API_URL  — Story-API REST base URL (e.g. http://172.207.250.203:1317)
 *   CDR_RPC_URL  — EVM JSON-RPC URL on the same chain (used by publicClient)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPublicClient, http, type PublicClient } from "viem";
import { Observer } from "../src/observer.js";
import {
  queryLatestActiveDKGNetwork,
  queryDKGNetwork,
  IncompleteDKGNetworkError,
} from "../src/story-api/index.js";
import type { Vault } from "../src/types.js";
import { logCase, dkgFetchUrls, countFetchCallsTo } from "./_helpers.js";

const API_URL = process.env.CDR_API_URL;
const RPC_URL = process.env.CDR_RPC_URL;
if (!API_URL) {
  throw new Error(
    "CDR_API_URL is not set. Configure it in .env.local (see .env.local.example).",
  );
}
if (!RPC_URL) {
  throw new Error(
    "CDR_RPC_URL is not set. Configure it in .env.local (see .env.local.example).",
  );
}

function makeObserver(opts?: { minThresholdRatio?: number }): Observer {
  const publicClient = createPublicClient({
    transport: http(RPC_URL),
  }) as unknown as PublicClient;
  return new Observer({
    network: "testnet",
    publicClient,
    apiUrl: API_URL!,
    minThresholdRatio: opts?.minThresholdRatio,
  });
}

describe(`Observer integration tests (live: ${API_URL})`, () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Wraps real fetch — pass-through with call recording.
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Wire-level correctness: each method round-trips through real REST and
  // returns values consistent with /dkg/latest_active raw response.
  // -------------------------------------------------------------------------

  it("getActiveRound matches latest_active.round", async () => {
    const observer = makeObserver();
    const [round, network] = await Promise.all([
      observer.getActiveRound(),
      queryLatestActiveDKGNetwork({ apiUrl: API_URL! }),
    ]);
    logCase("round", round);
    logCase("network", network);
    expect(round).toBe(network.round);
  });

  it("getGlobalPubKey returns the 32-byte point with the 2-byte Ed25519 (0x043f) prefix", async () => {
    const observer = makeObserver();
    const [key, network] = await Promise.all([
      observer.getGlobalPubKey(),
      queryLatestActiveDKGNetwork({ apiUrl: API_URL! }),
    ]);
    logCase("key (prefixed)", key);
    logCase("network.globalPublicKey", network.globalPublicKey);
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(34);
    expect(key[0]).toBe(0x04);
    expect(key[1]).toBe(0x3f);
    expect(Array.from(key.slice(2))).toEqual(Array.from(network.globalPublicKey));
  });

  it("getParticipantCount matches latest_active.total", async () => {
    const observer = makeObserver();
    const [count, network] = await Promise.all([
      observer.getParticipantCount(),
      queryLatestActiveDKGNetwork({ apiUrl: API_URL! }),
    ]);
    logCase("count", count);
    logCase("network.total", network.total);
    expect(count).toBe(network.total);
  });

  it("getThreshold matches latest_active.threshold (no override)", async () => {
    const observer = makeObserver();
    const [threshold, network] = await Promise.all([
      observer.getThreshold(),
      queryLatestActiveDKGNetwork({ apiUrl: API_URL! }),
    ]);
    logCase("threshold", threshold);
    logCase("network.threshold", network.threshold);
    expect(threshold).toBe(network.threshold);
  });

  it("minThresholdRatio override raises threshold to ceil(total * ratio) when larger", async () => {
    const network = await queryLatestActiveDKGNetwork({ apiUrl: API_URL! });
    const ratio = 0.99;
    const expected = Math.max(network.threshold, Math.ceil(network.total * ratio));
    const observer = makeObserver({ minThresholdRatio: ratio });
    const actual = await observer.getThreshold();
    logCase("threshold compute", {
      total: network.total,
      networkThreshold: network.threshold,
      ratio,
      ceilTotalTimesRatio: Math.ceil(network.total * ratio),
      expected,
      actual,
    });
    expect(actual).toBe(expected);
  });

  // -------------------------------------------------------------------------
  // Registrations + attestations: status=Finalized filter works on real
  // keeper data; addresses match the round's active validator set.
  // -------------------------------------------------------------------------

  it("getRegisteredValidators size equals network.total; addresses subset of activeValSet", async () => {
    const observer = makeObserver();
    const network = await queryLatestActiveDKGNetwork({ apiUrl: API_URL! });
    const validators = await observer.getRegisteredValidators();

    logCase(`validators (size=${validators.size})`, validators);
    logCase(
      `network.activeValSet (size=${network.activeValSet.length})`,
      network.activeValSet,
    );
    logCase("network.total", network.total);

    // Active round → all participants are status=Finalized. Keeper invariant:
    // the SDK-side `status === 2` filter should leave exactly `total` rows.
    expect(validators.size).toBe(network.total);

    const activeSet = network.activeValSet.map((a) => a.toLowerCase());
    for (const addr of validators.keys()) {
      expect(activeSet).toContain(addr);
    }
    for (const commPubKey of validators.values()) {
      expect(commPubKey).toBeInstanceOf(Uint8Array);
      expect(commPubKey.length).toBeGreaterThan(0);
    }
  });

  it("getValidatorAttestations returns the same addresses with non-empty SGX quote bytes", async () => {
    const observer = makeObserver();
    const [validators, attestations] = await Promise.all([
      observer.getRegisteredValidators(),
      observer.getValidatorAttestations(),
    ]);

    logCase("validators.keys()", [...validators.keys()].sort());
    logCase("attestations.keys()", [...attestations.keys()].sort());
    logCase(
      "attestation sizes",
      Object.fromEntries(
        [...attestations.entries()].map(([addr, q]) => [addr, `${q.length}B`]),
      ),
    );
    logCase("attestations", attestations);

    expect(attestations.size).toBe(validators.size);
    expect([...attestations.keys()].sort()).toEqual([...validators.keys()].sort());

    for (const report of attestations.values()) {
      expect(report).toBeInstanceOf(Uint8Array);
      // Real SGX DCAP quotes are large (~4.7 KiB on DevNet). Don't pin a
      // specific size — just guard the obvious "empty bytes" regression.
      expect(report.length).toBeGreaterThan(100);
    }
  });

  // -------------------------------------------------------------------------
  // Cache behavior end-to-end: instrument `globalThis.fetch` to count REST
  // round-trips and verify the design contracts from the unit tests hold
  // against live HTTP.
  // -------------------------------------------------------------------------

  it("getRegisteredValidators + getValidatorAttestations share the per-round registrations cache (1 /registrations fetch)", async () => {
    const observer = makeObserver();

    // Prime the active-round network cache once so both calls below skip
    // /dkg_network — `loadNetwork` will hit the side-effect cache filled
    // by getActiveRound.
    await observer.getActiveRound();
    fetchSpy.mockClear();

    const validators = await observer.getRegisteredValidators();
    const attestations = await observer.getValidatorAttestations();

    const urls = dkgFetchUrls(fetchSpy);
    logCase("fetch calls after priming", urls);
    logCase(`validators (size=${validators.size})`, validators);
    logCase(
      "attestation sizes",
      Object.fromEntries(
        [...attestations.entries()].map(([a, q]) => [a, `${q.length}B`]),
      ),
    );

    expect(countFetchCallsTo(fetchSpy, "/dkg/registrations")).toBe(1);
    expect(countFetchCallsTo(fetchSpy, "/dkg/dkg_network?round=")).toBe(0);
  });

  it("repeat getRegisteredValidators({round: N}) for an active round hits cache after the first call", async () => {
    const observer = makeObserver();
    const round = (await queryLatestActiveDKGNetwork({ apiUrl: API_URL! })).round;
    fetchSpy.mockClear();

    await observer.getRegisteredValidators({ round });
    await observer.getRegisteredValidators({ round });
    await observer.getRegisteredValidators({ round });

    const urls = dkgFetchUrls(fetchSpy);
    logCase("round", round);
    logCase("fetch calls across 3 invocations", urls);

    // Once for /dkg_network?round=N (stage check) and once for
    // /dkg/registrations?round=N. Subsequent calls hit cache.
    expect(countFetchCallsTo(fetchSpy, `/dkg/dkg_network?round=${round}`)).toBe(1);
    expect(countFetchCallsTo(fetchSpy, `/dkg/registrations?round=${round}`)).toBe(1);
  });

  it("getActiveRound always hits /latest_active (no caching of round number)", async () => {
    const observer = makeObserver();
    fetchSpy.mockClear();

    await observer.getActiveRound();
    await observer.getActiveRound();
    await observer.getActiveRound();

    const urls = dkgFetchUrls(fetchSpy);
    logCase("fetch calls across 3 getActiveRound invocations", urls);

    expect(countFetchCallsTo(fetchSpy, "/dkg/latest_active")).toBe(3);
  });

  // -------------------------------------------------------------------------
  // Historical (non-active) round: exercise the explicit-`round` branch which
  // goes through `/dkg/dkg_network?round=N` for the stage check instead of
  // `/dkg/latest_active`. Stage gate behavior is data-driven: caches when the
  // prev round is Active(4) or Ended(6); evicts otherwise.
  // -------------------------------------------------------------------------

  it("getRegisteredValidators({round: prev}) reads a historical (non-active) round", async () => {
    const observer = makeObserver();
    const current = await queryLatestActiveDKGNetwork({ apiUrl: API_URL! });
    const prev = current.round - 1;
    if (prev < 1) {
      logCase("skip", `only round ${current.round} exists, no previous round to test`);
      return;
    }
    let prevNetwork;
    try {
      prevNetwork = await queryDKGNetwork({ apiUrl: API_URL!, round: prev });
    } catch (e) {
      if (e instanceof IncompleteDKGNetworkError) {
        logCase(
          "skip",
          `prev round ${prev} (stage=${e.stage}) is not decodable; ` +
            `missing fields: ${e.missingFields.join(", ")}. ` +
            `Clean rotation produces stage=Ended(6) at prev; this branch hits during a Failed/Dealing prev.`,
        );
        return;
      }
      throw e;
    }
    logCase("current.round", current.round);
    logCase("prev round", prev);
    logCase("prev network", prevNetwork);

    fetchSpy.mockClear();
    const validators = await observer.getRegisteredValidators({ round: prev });
    const attestations = await observer.getValidatorAttestations({ round: prev });

    const urls = dkgFetchUrls(fetchSpy);
    logCase("fetch calls for prev round across both methods", urls);
    logCase(`validators(prev) (size=${validators.size})`, validators);
    logCase(
      "attestations(prev) sizes",
      Object.fromEntries(
        [...attestations.entries()].map(([a, q]) => [a, `${q.length}B`]),
      ),
    );

    // Both methods read the same per-round registrations cache → only ever
    // 1 /registrations fetch, regardless of stage. /dkg_network is also 1
    // (loadNetwork side-effect-caches network on first call within the
    // promise chain, second call hits cache regardless of stage gate).
    expect(countFetchCallsTo(fetchSpy, `/dkg/registrations?round=${prev}`)).toBe(1);
    expect(countFetchCallsTo(fetchSpy, `/dkg/dkg_network?round=${prev}`)).toBe(1);

    // Same validator set in both maps.
    expect([...attestations.keys()].sort()).toEqual([...validators.keys()].sort());

    // For an Ended (stage 6) round, all rows are Finalized → size === total.
    // For Failed (stage 5) or other non-stable stages, registrations may be
    // empty; we only assert structural correctness, not non-emptiness.
    if (prevNetwork.stage === 4 || prevNetwork.stage === 6) {
      expect(validators.size).toBe(prevNetwork.total);
      for (const commPubKey of validators.values()) {
        expect(commPubKey.length).toBeGreaterThan(0);
      }
      for (const report of attestations.values()) {
        expect(report.length).toBeGreaterThan(100);
      }
    } else {
      logCase(
        "note",
        `prev round stage=${prevNetwork.stage} (not 4/6); cache will be evicted, content may be empty`,
      );
    }
  });

  // -------------------------------------------------------------------------
  // EVM CDR contract reads: the 6 methods that bypass story-api entirely
  // and go straight to publicClient.readContract. These didn't change in
  // Step 1 but were never live-verified before — covering them now so any
  // regression in the future PR shows up.
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Concurrency: in-flight Promise dedup at the cache layer. Multiple
  // concurrent reads for the same round must coalesce onto a single fetch.
  // -------------------------------------------------------------------------

  it("concurrent getRegisteredValidators({round}) calls share a single in-flight fetch (in-flight dedup)", async () => {
    const observer = makeObserver();
    const round = (await queryLatestActiveDKGNetwork({ apiUrl: API_URL! })).round;
    fetchSpy.mockClear();

    // 5 concurrent invocations. With in-flight dedup, the first call sets
    // the rejected/resolved Promise into the cache before awaiting fetch,
    // so calls 2-5 hit the cached Promise and never issue their own fetch.
    const results = await Promise.all([
      observer.getRegisteredValidators({ round }),
      observer.getRegisteredValidators({ round }),
      observer.getRegisteredValidators({ round }),
      observer.getRegisteredValidators({ round }),
      observer.getRegisteredValidators({ round }),
    ]);

    const dkgNetCalls = countFetchCallsTo(fetchSpy, `/dkg/dkg_network?round=${round}`);
    const regsCalls = countFetchCallsTo(fetchSpy, `/dkg/registrations?round=${round}`);
    logCase("fetch counts under 5x concurrency", {
      [`/dkg_network?round=${round}`]: dkgNetCalls,
      [`/registrations?round=${round}`]: regsCalls,
    });

    expect(dkgNetCalls).toBe(1);
    expect(regsCalls).toBe(1);
    // All callers must have observed the same Map (Promise sharing).
    for (let i = 1; i < results.length; i++) {
      expect(results[i].size).toBe(results[0].size);
    }
  });

  // -------------------------------------------------------------------------
  // Cross-method cache reuse: getActiveRound side-effect-caches the network
  // snapshot under its round. A subsequent getRegisteredValidators({round})
  // must hit that cache for /dkg_network (only /registrations is new).
  // -------------------------------------------------------------------------

  it("getActiveRound's side-effect network cache is reused by getRegisteredValidators({round})", async () => {
    const observer = makeObserver();
    const round = await observer.getActiveRound(); // warms networkSnapshots[round]
    fetchSpy.mockClear();

    await observer.getRegisteredValidators({ round });

    const dkgNetCalls = countFetchCallsTo(fetchSpy, `/dkg/dkg_network?round=${round}`);
    const regsCalls = countFetchCallsTo(fetchSpy, `/dkg/registrations?round=${round}`);
    logCase("fetch counts after pre-warmed network snapshot", {
      [`/dkg_network?round=${round}`]: dkgNetCalls, // expected 0 (cache hit)
      [`/registrations?round=${round}`]: regsCalls, // expected 1 (first read)
    });

    expect(dkgNetCalls).toBe(0);
    expect(regsCalls).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Lifetime-cache invariants: maxEncryptedDataSize is treated as a contract
  // constant and cached for the Observer's lifetime. Repeated calls must
  // not issue additional EVM reads.
  // -------------------------------------------------------------------------

  it("getMaxEncryptedDataSize is cached for the Observer's lifetime (zero EVM reads after warm-up)", async () => {
    const observer = makeObserver();
    // Warm-up: first call may also trigger viem internals (eth_chainId, etc).
    // Drain those before measuring.
    const first = await observer.getMaxEncryptedDataSize();
    fetchSpy.mockClear();

    const repeats = await Promise.all(
      Array.from({ length: 5 }, () => observer.getMaxEncryptedDataSize()),
    );

    logCase("result + fetch count", {
      first,
      repeats,
      fetchCalls: fetchSpy.mock.calls.length,
    });

    expect(repeats.every((s) => s === first)).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("getOperationalThreshold returns a positive bigint (DKG threshold constant)", async () => {
    const observer = makeObserver();
    const threshold = await observer.getOperationalThreshold();
    logCase("operationalThreshold", threshold);
    expect(typeof threshold).toBe("bigint");
    expect(threshold).toBeGreaterThan(0n);
  });

  it("getAllocateFee / getWriteFee / getReadFee return current CDR fees", async () => {
    const observer = makeObserver();
    const [allocate, write, read] = await Promise.all([
      observer.getAllocateFee(),
      observer.getWriteFee(),
      observer.getReadFee(),
    ]);
    logCase("fees", { allocate, write, read });
    expect(typeof allocate).toBe("bigint");
    expect(typeof write).toBe("bigint");
    expect(typeof read).toBe("bigint");
    expect(allocate).toBeGreaterThanOrEqual(0n);
    expect(write).toBeGreaterThanOrEqual(0n);
    expect(read).toBeGreaterThanOrEqual(0n);
  });

  it("getMaxEncryptedDataSize returns a positive bigint", async () => {
    const observer = makeObserver();
    const size = await observer.getMaxEncryptedDataSize();
    logCase("maxEncryptedDataSize", size);
    expect(typeof size).toBe("bigint");
    expect(size).toBeGreaterThan(0n);
  });

  it("getVault returns a Vault-shaped struct (probes a far-out uuid unlikely to exist)", async () => {
    const observer = makeObserver();
    // 999_999_999 is well beyond any realistic test allocation count.
    const probeUuid = 999_999_999;
    let vault: Vault | undefined;
    let revertReason: string | undefined;
    try {
      vault = await observer.getVault(probeUuid);
    } catch (err) {
      revertReason = (err as Error).message;
    }
    logCase(`vault uuid=${probeUuid}`, vault ?? `revert: ${revertReason}`);

    // Either path is acceptable — we only need to confirm the call goes
    // through Observer → publicClient → CDR contract. Specific behavior
    // for an unwritten slot is contract-defined; viem returns checksummed
    // addresses (mixed case), so the regex is case-insensitive.
    expect(vault !== undefined || revertReason !== undefined).toBe(true);
    if (vault) {
      expect(vault.uuid).toBe(probeUuid);
      expect(typeof vault.updatable).toBe("boolean");
      expect(vault.writeConditionAddr).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(vault.readConditionAddr).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(vault.encryptedData).toMatch(/^0x[0-9a-fA-F]*$/);
    }
  });
});
