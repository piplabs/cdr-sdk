import { describe, it, expect, vi, beforeEach } from "vitest";
import { Observer } from "../src/observer.js";
import {
  queryLatestActiveDKGNetwork,
  queryDKGNetwork,
  queryAllRegistrations,
} from "../src/story-api/client.js";
import type { DKGNetwork, DKGRegistration } from "../src/story-api/types.js";

vi.mock("../src/story-api/client.js", () => ({
  queryLatestActiveDKGNetwork: vi.fn(),
  queryDKGNetwork: vi.fn(),
  queryAllRegistrations: vi.fn(),
  queryGlobalPubKey: vi.fn(),
  queryVerifiedRegistrations: vi.fn(),
  queryCDRPartials: vi.fn(),
}));

const API_URL = "http://test:1317";

function makeNetwork(overrides: Partial<DKGNetwork> = {}): DKGNetwork {
  return {
    round: 4,
    startBlockHeight: 100n,
    startBlockHash: new Uint8Array(),
    activeValSet: [],
    total: 3,
    threshold: 2,
    stage: 4, // Active
    isResharing: false,
    globalPublicKey: new Uint8Array(32).fill(0xab),
    publicCoeffs: [],
    ...overrides,
  };
}

function makeRegistration(overrides: Partial<DKGRegistration> = {}): DKGRegistration {
  return {
    round: 4,
    validatorAddr: "0x0000000000000000000000000000000000000001",
    index: 1,
    dkgPubKey: new Uint8Array(),
    commPubKey: new Uint8Array(64).fill(0x11),
    enclaveReport: new Uint8Array(100).fill(0x22),
    status: 2, // Finalized
    codeCommitment: new Uint8Array(),
    enclaveType: new Uint8Array(),
    ...overrides,
  };
}

function mockPublicClient(overrides: Record<string, unknown> = {}) {
  return {
    readContract: vi.fn(),
    getLogs: vi.fn(),
    getBlockNumber: vi.fn().mockResolvedValue(1000n),
    ...overrides,
  } as any;
}

beforeEach(() => {
  vi.mocked(queryLatestActiveDKGNetwork).mockReset();
  vi.mocked(queryDKGNetwork).mockReset();
  vi.mocked(queryAllRegistrations).mockReset();
});

describe("Observer", () => {
  describe("CDR contract reads (EVM)", () => {
    it("getVault reads vault from CDR contract", async () => {
      const client = mockPublicClient();
      client.readContract.mockResolvedValueOnce({
        updatable: false,
        writeConditionAddr: "0x1111111111111111111111111111111111111111",
        readConditionAddr: "0x2222222222222222222222222222222222222222",
        writeConditionData: "0x",
        readConditionData: "0x",
        encryptedData: "0xabcdef",
      });
      const observer = new Observer({ network: "testnet", publicClient: client, apiUrl: API_URL });
      const vault = await observer.getVault(1);
      expect(client.readContract).toHaveBeenCalledOnce();
      expect(vault.encryptedData).toBe("0xabcdef");
    });

    it("getOperationalThreshold reads from DKG contract", async () => {
      const client = mockPublicClient();
      client.readContract.mockResolvedValueOnce(3n);
      const observer = new Observer({ network: "testnet", publicClient: client, apiUrl: API_URL });
      expect(await observer.getOperationalThreshold()).toBe(3n);
    });

    it("fee getters call the CDR contract", async () => {
      const client = mockPublicClient();
      client.readContract
        .mockResolvedValueOnce(1n)
        .mockResolvedValueOnce(2n)
        .mockResolvedValueOnce(3n)
        .mockResolvedValueOnce(4n);
      const observer = new Observer({ network: "testnet", publicClient: client, apiUrl: API_URL });
      expect(await observer.getAllocateFee()).toBe(1n);
      expect(await observer.getWriteFee()).toBe(2n);
      expect(await observer.getReadFee()).toBe(3n);
      expect(await observer.getMaxEncryptedDataSize()).toBe(4n);
    });
  });

  describe("DKG queries via Story-API REST", () => {
    it("getActiveRound returns round from /latest_active", async () => {
      vi.mocked(queryLatestActiveDKGNetwork).mockResolvedValue(makeNetwork({ round: 7 }));
      const observer = new Observer({ network: "testnet", publicClient: mockPublicClient(), apiUrl: API_URL });
      expect(await observer.getActiveRound()).toBe(7);
      expect(queryLatestActiveDKGNetwork).toHaveBeenCalledWith({ apiUrl: API_URL });
    });

    it("getActiveRound always hits REST (no caching of round number)", async () => {
      vi.mocked(queryLatestActiveDKGNetwork).mockResolvedValue(makeNetwork({ round: 7 }));
      const observer = new Observer({ network: "testnet", publicClient: mockPublicClient(), apiUrl: API_URL });
      await observer.getActiveRound();
      await observer.getActiveRound();
      await observer.getActiveRound();
      expect(queryLatestActiveDKGNetwork).toHaveBeenCalledTimes(3);
    });

    it("getGlobalPubKey returns 32-byte point with 2-byte Ed25519 prefix", async () => {
      const point = new Uint8Array(32).fill(0xab);
      vi.mocked(queryLatestActiveDKGNetwork).mockResolvedValue(makeNetwork({ globalPublicKey: point }));
      const observer = new Observer({ network: "testnet", publicClient: mockPublicClient(), apiUrl: API_URL });
      const result = await observer.getGlobalPubKey();
      expect(result.length).toBe(34);
      expect(result[0]).toBe(0x04);
      expect(result[1]).toBe(0x3f);
      expect(Array.from(result.slice(2))).toEqual(Array.from(point));
    });

    it("getParticipantCount returns network.total", async () => {
      vi.mocked(queryLatestActiveDKGNetwork).mockResolvedValue(makeNetwork({ total: 5 }));
      const observer = new Observer({ network: "testnet", publicClient: mockPublicClient(), apiUrl: API_URL });
      expect(await observer.getParticipantCount()).toBe(5);
    });

    it("getThreshold returns network.threshold", async () => {
      vi.mocked(queryLatestActiveDKGNetwork).mockResolvedValue(makeNetwork({ threshold: 3, total: 5 }));
      const observer = new Observer({ network: "testnet", publicClient: mockPublicClient(), apiUrl: API_URL });
      expect(await observer.getThreshold()).toBe(3);
    });

    it("getThreshold applies minThresholdRatio override (max wins)", async () => {
      vi.mocked(queryLatestActiveDKGNetwork).mockResolvedValue(makeNetwork({ threshold: 2, total: 6 }));
      const observer = new Observer({
        network: "testnet",
        publicClient: mockPublicClient(),
        apiUrl: API_URL,
        minThresholdRatio: 0.67,
      });
      // ceil(6 * 0.67) = 5 wins over network.threshold=2.
      expect(await observer.getThreshold()).toBe(5);
    });

    it("getThreshold uses source threshold when ratio override is smaller", async () => {
      vi.mocked(queryLatestActiveDKGNetwork).mockResolvedValue(makeNetwork({ threshold: 4, total: 6 }));
      const observer = new Observer({
        network: "testnet",
        publicClient: mockPublicClient(),
        apiUrl: API_URL,
        minThresholdRatio: 0.5,
      });
      // ceil(6 * 0.5) = 3 < network.threshold=4 → returns 4.
      expect(await observer.getThreshold()).toBe(4);
    });

    it.each([1.01, 1.5, 2, -0.001, -1, NaN, Infinity, -Infinity])(
      "constructor rejects out-of-range minThresholdRatio (%s)",
      (bad) => {
        expect(
          () =>
            new Observer({
              network: "testnet",
              publicClient: mockPublicClient(),
              apiUrl: API_URL,
              minThresholdRatio: bad,
            }),
        ).toThrow(/minThresholdRatio must be a finite number in \[0, 1\]/);
      },
    );

    it.each([0, 0.5, 1])(
      "constructor accepts in-range minThresholdRatio (%s)",
      (ok) => {
        expect(
          () =>
            new Observer({
              network: "testnet",
              publicClient: mockPublicClient(),
              apiUrl: API_URL,
              minThresholdRatio: ok,
            }),
        ).not.toThrow();
      },
    );
  });

  describe("getRegisteredValidators / getValidatorAttestations", () => {
    it("returns map of validator address → commPubKey for active round", async () => {
      vi.mocked(queryLatestActiveDKGNetwork).mockResolvedValue(makeNetwork({ round: 4 }));
      vi.mocked(queryAllRegistrations).mockResolvedValue([
        makeRegistration({
          validatorAddr: "0xAAAAaaaaaaaaaAAAAaaaaaaAaaAaAaAaAAaAAaaA",
          commPubKey: new Uint8Array(64).fill(0x11),
          status: 2,
        }),
      ]);
      const observer = new Observer({ network: "testnet", publicClient: mockPublicClient(), apiUrl: API_URL });
      const validators = await observer.getRegisteredValidators();
      expect(validators.size).toBe(1);
      expect(validators.get("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")?.length).toBe(64);
    });

    it("filters out non-Finalized registrations (status !== 2)", async () => {
      vi.mocked(queryLatestActiveDKGNetwork).mockResolvedValue(makeNetwork({ round: 4 }));
      vi.mocked(queryAllRegistrations).mockResolvedValue([
        makeRegistration({ validatorAddr: "0x0000000000000000000000000000000000000001", status: 1 }), // Verified — out
        makeRegistration({ validatorAddr: "0x0000000000000000000000000000000000000002", status: 2 }), // Finalized — kept
        makeRegistration({ validatorAddr: "0x0000000000000000000000000000000000000003", status: 3 }), // Invalidated — out
      ]);
      const observer = new Observer({ network: "testnet", publicClient: mockPublicClient(), apiUrl: API_URL });
      const validators = await observer.getRegisteredValidators();
      expect(validators.size).toBe(1);
      expect(validators.has("0x0000000000000000000000000000000000000002")).toBe(true);
    });

    it("getValidatorAttestations returns enclaveReport from same registrations", async () => {
      vi.mocked(queryLatestActiveDKGNetwork).mockResolvedValue(makeNetwork({ round: 4 }));
      const enclaveBytes = new Uint8Array(100).fill(0x99);
      vi.mocked(queryAllRegistrations).mockResolvedValue([
        makeRegistration({
          validatorAddr: "0x0000000000000000000000000000000000000001",
          enclaveReport: enclaveBytes,
          status: 2,
        }),
      ]);
      const observer = new Observer({ network: "testnet", publicClient: mockPublicClient(), apiUrl: API_URL });
      const att = await observer.getValidatorAttestations();
      expect(att.size).toBe(1);
      expect(Array.from(att.get("0x0000000000000000000000000000000000000001")!)).toEqual(Array.from(enclaveBytes));
    });

    it("explicit round skips /latest_active and queries /dkg_network?round=N", async () => {
      vi.mocked(queryDKGNetwork).mockResolvedValue(makeNetwork({ round: 5, stage: 6 })); // Ended
      vi.mocked(queryAllRegistrations).mockResolvedValue([
        makeRegistration({ round: 5, validatorAddr: "0x0000000000000000000000000000000000000001", status: 2 }),
      ]);
      const observer = new Observer({ network: "testnet", publicClient: mockPublicClient(), apiUrl: API_URL });
      const validators = await observer.getRegisteredValidators({ round: 5 });
      expect(validators.size).toBe(1);
      expect(queryLatestActiveDKGNetwork).not.toHaveBeenCalled();
      expect(queryDKGNetwork).toHaveBeenCalledWith({ apiUrl: API_URL, round: 5 });
      expect(queryAllRegistrations).toHaveBeenCalledWith({ apiUrl: API_URL, round: 5 });
    });
  });

  describe("Caching", () => {
    it("getRegisteredValidators + getValidatorAttestations share registrations cache (1 fetch)", async () => {
      vi.mocked(queryLatestActiveDKGNetwork).mockResolvedValue(makeNetwork({ round: 4 }));
      vi.mocked(queryAllRegistrations).mockResolvedValue([makeRegistration({ status: 2 })]);
      const observer = new Observer({ network: "testnet", publicClient: mockPublicClient(), apiUrl: API_URL });
      await observer.getRegisteredValidators();
      await observer.getValidatorAttestations();
      expect(queryAllRegistrations).toHaveBeenCalledTimes(1);
    });

    it("repeat calls for same round hit registrations cache", async () => {
      vi.mocked(queryDKGNetwork).mockResolvedValue(makeNetwork({ round: 5, stage: 6 }));
      vi.mocked(queryAllRegistrations).mockResolvedValue([makeRegistration({ round: 5, status: 2 })]);
      const observer = new Observer({ network: "testnet", publicClient: mockPublicClient(), apiUrl: API_URL });
      await observer.getRegisteredValidators({ round: 5 });
      await observer.getRegisteredValidators({ round: 5 });
      await observer.getRegisteredValidators({ round: 5 });
      expect(queryAllRegistrations).toHaveBeenCalledTimes(1);
      expect(queryDKGNetwork).toHaveBeenCalledTimes(1);
    });

    it("concurrent calls for same round dedupe (in-flight promise)", async () => {
      let resolveRegs!: (regs: DKGRegistration[]) => void;
      vi.mocked(queryDKGNetwork).mockResolvedValue(makeNetwork({ round: 5, stage: 6 }));
      vi.mocked(queryAllRegistrations).mockImplementation(
        () => new Promise<DKGRegistration[]>((resolve) => { resolveRegs = resolve; }),
      );
      const observer = new Observer({ network: "testnet", publicClient: mockPublicClient(), apiUrl: API_URL });
      const promises = [
        observer.getRegisteredValidators({ round: 5 }),
        observer.getRegisteredValidators({ round: 5 }),
        observer.getRegisteredValidators({ round: 5 }),
      ];
      resolveRegs([makeRegistration({ round: 5, status: 2 })]);
      const results = await Promise.all(promises);
      expect(results.every((r) => r.size === 1)).toBe(true);
      expect(queryAllRegistrations).toHaveBeenCalledTimes(1);
    });

    it("does NOT cache when round stage is non-stable (e.g. Dealing)", async () => {
      vi.mocked(queryDKGNetwork).mockResolvedValue(makeNetwork({ round: 5, stage: 2 })); // Dealing
      vi.mocked(queryAllRegistrations).mockResolvedValue([makeRegistration({ round: 5, status: 2 })]);
      const observer = new Observer({ network: "testnet", publicClient: mockPublicClient(), apiUrl: API_URL });
      await observer.getRegisteredValidators({ round: 5 });
      // Flush microtasks so the eviction Promise.all chain runs before the next call.
      await Promise.resolve();
      await Promise.resolve();
      await observer.getRegisteredValidators({ round: 5 });
      expect(queryAllRegistrations).toHaveBeenCalledTimes(2);
      expect(queryDKGNetwork).toHaveBeenCalledTimes(2);
    });

    it("DOES cache when round stage is Active (4)", async () => {
      vi.mocked(queryDKGNetwork).mockResolvedValue(makeNetwork({ round: 4, stage: 4 }));
      vi.mocked(queryAllRegistrations).mockResolvedValue([makeRegistration({ round: 4, status: 2 })]);
      const observer = new Observer({ network: "testnet", publicClient: mockPublicClient(), apiUrl: API_URL });
      await observer.getRegisteredValidators({ round: 4 });
      await observer.getRegisteredValidators({ round: 4 });
      expect(queryAllRegistrations).toHaveBeenCalledTimes(1);
    });

    it("DOES cache when round stage is Ended (6)", async () => {
      vi.mocked(queryDKGNetwork).mockResolvedValue(makeNetwork({ round: 5, stage: 6 }));
      vi.mocked(queryAllRegistrations).mockResolvedValue([makeRegistration({ round: 5, status: 2 })]);
      const observer = new Observer({ network: "testnet", publicClient: mockPublicClient(), apiUrl: API_URL });
      await observer.getRegisteredValidators({ round: 5 });
      await observer.getRegisteredValidators({ round: 5 });
      expect(queryAllRegistrations).toHaveBeenCalledTimes(1);
    });

    it("active-round registrations reuse network from /latest_active side-effect cache (no /dkg_network call)", async () => {
      vi.mocked(queryLatestActiveDKGNetwork).mockResolvedValue(makeNetwork({ round: 4, stage: 4 }));
      vi.mocked(queryAllRegistrations).mockResolvedValue([makeRegistration({ round: 4, status: 2 })]);
      const observer = new Observer({ network: "testnet", publicClient: mockPublicClient(), apiUrl: API_URL });
      // First call: getActiveRound() side-effect caches network for round 4.
      // Second call: explicit round=4, loadNetwork hits cache, no /dkg_network call.
      await observer.getRegisteredValidators();
      await observer.getRegisteredValidators({ round: 4 });
      expect(queryDKGNetwork).not.toHaveBeenCalled();
      // /latest_active called once for the implicit-round call; second is round-explicit.
      expect(queryLatestActiveDKGNetwork).toHaveBeenCalledTimes(1);
    });
  });
});
