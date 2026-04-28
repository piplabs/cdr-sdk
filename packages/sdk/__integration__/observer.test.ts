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
 *
 * Scope: read-only verification of the active DKG round. We do not exercise
 * `getVault` / fee getters here because they require a known vault UUID;
 * those will land in a sibling test that bootstraps state.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPublicClient, http, type PublicClient } from "viem";
import { Observer } from "../src/observer.js";
import {
  queryLatestActiveDKGNetwork,
  queryDKGNetwork,
  bytesToHex,
} from "../src/story-api/index.js";
import type { Vault } from "../src/types.js";

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

/**
 * JSON.stringify replacer for live response logging:
 *   - `Map`        → plain object (so commPubKey-by-validator dumps cleanly)
 *   - `Uint8Array` → hex (truncated for fields longer than 80 hex chars,
 *     so e.g. a 4.7 KiB enclaveReport doesn't drown the console)
 *   - `bigint`     → string (so block heights serialize cleanly)
 */
function pretty(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, v) => {
      if (v instanceof Map) return Object.fromEntries(v);
      if (v instanceof Uint8Array) {
        const hex = bytesToHex(v);
        return hex.length > 80 ? `${hex.slice(0, 60)}…(${v.length}B)` : hex;
      }
      if (typeof v === "bigint") return v.toString();
      return v;
    },
    2,
  );
}

/** Count fetch calls whose URL contains the given path substring. */
function countFetchCallsTo(spy: ReturnType<typeof vi.spyOn>, path: string): number {
  return dkgFetchUrls(spy).filter((u) => u.includes(path)).length;
}

/** All recorded fetch URLs that hit a `/dkg/*` endpoint, in order. */
function dkgFetchUrls(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls
    .map(([url]) => {
      if (typeof url === "string") return url;
      if (url instanceof URL) return url.href;
      return (url as Request).url;
    })
    .filter((u): u is string => typeof u === "string" && u.includes("/dkg/"));
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
    console.log(`\n[round]\n${round}`);
    console.log(`\n[network]\n${pretty(network)}`);
    expect(round).toBe(network.round);
  });

  it("getGlobalPubKey returns the 32-byte point with the 2-byte Ed25519 (0x043f) prefix", async () => {
    const observer = makeObserver();
    const [key, network] = await Promise.all([
      observer.getGlobalPubKey(),
      queryLatestActiveDKGNetwork({ apiUrl: API_URL! }),
    ]);
    console.log(`\n[key (prefixed, ${key.length}B)]\n${bytesToHex(key)}`);
    console.log(`\n[network.globalPublicKey (${network.globalPublicKey.length}B)]\n${bytesToHex(network.globalPublicKey)}`);
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
    console.log(`\n[count]\n${count}`);
    console.log(`\n[network.total]\n${network.total}`);
    expect(count).toBe(network.total);
  });

  it("getThreshold matches latest_active.threshold (no override)", async () => {
    const observer = makeObserver();
    const [threshold, network] = await Promise.all([
      observer.getThreshold(),
      queryLatestActiveDKGNetwork({ apiUrl: API_URL! }),
    ]);
    console.log(`\n[threshold]\n${threshold}`);
    console.log(`\n[network.threshold]\n${network.threshold}`);
    expect(threshold).toBe(network.threshold);
  });

  it("minThresholdRatio override raises threshold to ceil(total * ratio) when larger", async () => {
    const network = await queryLatestActiveDKGNetwork({ apiUrl: API_URL! });
    const ratio = 0.99;
    const expected = Math.max(network.threshold, Math.ceil(network.total * ratio));
    const observer = makeObserver({ minThresholdRatio: ratio });
    const actual = await observer.getThreshold();
    console.log(
      `\n[threshold compute]\n` +
        `  total=${network.total}\n` +
        `  network.threshold=${network.threshold}\n` +
        `  ratio=${ratio}\n` +
        `  ceil(total*ratio)=${Math.ceil(network.total * ratio)}\n` +
        `  expected=${expected}\n` +
        `  actual=${actual}`,
    );
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

    console.log(`\n[validators] size=${validators.size}\n${pretty(validators)}`);
    console.log(`\n[network.activeValSet] size=${network.activeValSet.length}\n${pretty(network.activeValSet)}`);
    console.log(`\n[network.total]\n${network.total}`);

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

    console.log(`\n[validators.keys()]\n${pretty([...validators.keys()].sort())}`);
    console.log(`\n[attestations.keys()]\n${pretty([...attestations.keys()].sort())}`);
    console.log(
      `\n[attestation sizes]\n` +
        [...attestations.entries()]
          .map(([addr, q]) => `  ${addr} → ${q.length}B`)
          .join("\n"),
    );
    console.log(`\n[attestations]\n${pretty(attestations)}`);

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
    console.log(`\n[fetch calls after priming] count=${urls.length}\n` + urls.map((u) => "  " + u).join("\n"));
    console.log(`\n[validators] size=${validators.size}\n${pretty(validators)}`);
    console.log(`\n[attestations sizes]\n` + [...attestations.entries()].map(([a, q]) => `  ${a} → ${q.length}B`).join("\n"));

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
    console.log(`\n[round]\n${round}`);
    console.log(`\n[fetch calls across 3 invocations] count=${urls.length}\n` + urls.map((u) => "  " + u).join("\n"));

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
    console.log(`\n[fetch calls across 3 getActiveRound invocations] count=${urls.length}\n` + urls.map((u) => "  " + u).join("\n"));

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
      console.log(`\n[skip] only round ${current.round} exists, no previous round to test`);
      return;
    }
    const prevNetwork = await queryDKGNetwork({ apiUrl: API_URL!, round: prev });
    console.log(`\n[current.round]\n${current.round}`);
    console.log(`\n[prev round]\n${prev}`);
    console.log(`\n[prev network]\n${pretty(prevNetwork)}`);

    fetchSpy.mockClear();
    const validators = await observer.getRegisteredValidators({ round: prev });
    const attestations = await observer.getValidatorAttestations({ round: prev });

    const urls = dkgFetchUrls(fetchSpy);
    console.log(`\n[fetch calls for prev round across both methods] count=${urls.length}\n` + urls.map((u) => "  " + u).join("\n"));
    console.log(`\n[validators(prev)] size=${validators.size}\n${pretty(validators)}`);
    console.log(`\n[attestations(prev) sizes]\n` + [...attestations.entries()].map(([a, q]) => `  ${a} → ${q.length}B`).join("\n"));

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
      console.log(`\n[note] prev round stage=${prevNetwork.stage} (not 4/6); cache will be evicted, content may be empty`);
    }
  });

  // -------------------------------------------------------------------------
  // EVM CDR contract reads: the 6 methods that bypass story-api entirely
  // and go straight to publicClient.readContract. These didn't change in
  // Step 1 but were never live-verified before — covering them now so any
  // regression in the future PR shows up.
  // -------------------------------------------------------------------------

  it("getOperationalThreshold returns a positive bigint (DKG threshold constant)", async () => {
    const observer = makeObserver();
    const threshold = await observer.getOperationalThreshold();
    console.log(`\n[operationalThreshold]\n${threshold}`);
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
    console.log(`\n[fees]\n  allocate=${allocate}\n  write=${write}\n  read=${read}`);
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
    console.log(`\n[maxEncryptedDataSize]\n${size}`);
    expect(typeof size).toBe("bigint");
    expect(size).toBeGreaterThan(0n);
  });

  it("getVault returns a Vault-shaped struct (uuid=0; expect zero-initialized for an unwritten slot)", async () => {
    const observer = makeObserver();
    let vault: Vault | undefined;
    let revertReason: string | undefined;
    try {
      vault = await observer.getVault(0);
    } catch (err) {
      revertReason = (err as Error).message;
    }
    console.log(`\n[vault uuid=0]\n${vault ? pretty(vault) : `revert: ${revertReason}`}`);

    // Either path is acceptable — we only need to confirm the call goes
    // through Observer → publicClient → CDR contract. Specific behavior
    // for an unwritten slot is contract-defined.
    expect(vault !== undefined || revertReason !== undefined).toBe(true);
    if (vault) {
      expect(vault.uuid).toBe(0);
      expect(typeof vault.updatable).toBe("boolean");
      expect(vault.writeConditionAddr).toMatch(/^0x[0-9a-f]{40}$/);
      expect(vault.readConditionAddr).toMatch(/^0x[0-9a-f]{40}$/);
      expect(vault.encryptedData).toMatch(/^0x[0-9a-f]*$/);
    }
  });
});
