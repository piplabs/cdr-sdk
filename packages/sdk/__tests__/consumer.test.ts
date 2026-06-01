import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@piplabs/cdr-crypto", () => ({
  tdh2Encrypt: vi.fn(),
  encryptFile: vi.fn(),
  getWasm: vi.fn().mockReturnValue(null),
  decryptPartial: vi.fn(),
  tdh2Combine: vi.fn(),
  decryptFile: vi.fn(),
  generateEphemeralKeyPair: vi.fn(),
  verifyPartialSignature: vi.fn(),
  CURVE_ED25519: 1,
}));

vi.mock("../src/story-api/client.js", () => ({
  queryCDRPartials: vi.fn(),
  queryLatestActiveDKGNetwork: vi.fn(),
  queryDKGNetwork: vi.fn(),
  queryGlobalPubKey: vi.fn(),
  queryAllRegistrations: vi.fn(),
  queryVerifiedRegistrations: vi.fn(),
}));

vi.mock("../src/attestation.js", () => ({
  verifyAttestation: vi.fn(),
  parseSgxQuote: vi.fn(),
}));

import { Consumer } from "../src/consumer.js";
import { queryCDRPartials } from "../src/story-api/client.js";
import { verifyAttestation } from "../src/attestation.js";
import {
  decryptPartial,
  tdh2Combine,
  generateEphemeralKeyPair,
} from "@piplabs/cdr-crypto";
import {
  PartialCollectionTimeoutError,
  InvalidParamsError,
  EmptyVaultError,
  InvalidPartialError,
  InsufficientBalanceError,
} from "../src/errors.js";
import type { CDRLogger } from "../src/logger.js";
import { toHex } from "viem";
import type { Observer } from "../src/observer.js";
import type { DKGPartialDecryptionSubmission } from "../src/story-api/types.js";

const API_URL = "http://test:1317";
const VALIDATOR_A = "0x0000000000000000000000000000000000000001" as const;
const VALIDATOR_B = "0x0000000000000000000000000000000000000002" as const;
const VALIDATOR_C = "0x0000000000000000000000000000000000000003" as const;

function makeFakeObserver(opts: {
  threshold?: number;
  /**
   * Per-round threshold lookup. Number → constant, fn → derived from round
   * (lets #76 tests return e.g. 2 for round 10 vs 3 for the active round).
   * Defaults to `threshold` so legacy tests don't have to specify both.
   */
  thresholdAt?: number | ((round: number) => number);
  registrations?: Map<string, Uint8Array>;
  attestations?: Map<string, Uint8Array>;
  globalPubKey?: Uint8Array;
} = {}): Observer {
  const threshold = opts.threshold ?? 2;
  return {
    getThreshold: vi.fn().mockResolvedValue(threshold),
    getThresholdAt: vi.fn().mockImplementation((round: number) => {
      if (typeof opts.thresholdAt === "function") {
        return Promise.resolve(opts.thresholdAt(round));
      }
      return Promise.resolve(opts.thresholdAt ?? threshold);
    }),
    getRegisteredValidators: vi
      .fn()
      .mockResolvedValue(opts.registrations ?? new Map()),
    getValidatorAttestations: vi
      .fn()
      .mockResolvedValue(opts.attestations ?? new Map()),
    getGlobalPubKey: vi.fn().mockResolvedValue(opts.globalPubKey ?? new Uint8Array(34)),
    getActiveRound: vi.fn().mockResolvedValue(4),
    getParticipantCount: vi.fn().mockResolvedValue(3),
  } as unknown as Observer;
}

/** Default ciphertext byte string used by `makeGroup` and `mockClients`. */
const DEFAULT_CIPHERTEXT_BYTES = new Uint8Array([0x01]);

function makeSubmission(opts: {
  validator: `0x${string}`;
  pid: number;
  round?: number;
  ciphertext?: Uint8Array;
}): DKGPartialDecryptionSubmission {
  return {
    validator: opts.validator,
    round: opts.round ?? 4,
    pid: opts.pid,
    encryptedPartial: new Uint8Array([1, 2, 3]),
    ephemeralPubKey: new Uint8Array(65).fill(0xaa),
    pubShare: new Uint8Array(34).fill(0xbb),
    ciphertext: opts.ciphertext ?? DEFAULT_CIPHERTEXT_BYTES,
    label: new Uint8Array(32).fill(0xdd),
  };
}

function makeGroup(opts: {
  round?: number;
  submissions: DKGPartialDecryptionSubmission[];
  thresholdMet?: boolean;
  ciphertext?: Uint8Array;
  threshold?: number;
}) {
  return {
    round: opts.round ?? 4,
    submissions: opts.submissions,
    ciphertext: opts.ciphertext ?? DEFAULT_CIPHERTEXT_BYTES,
    threshold: opts.threshold ?? 2,
    thresholdMet: opts.thresholdMet ?? true,
  };
}

function mockClients(opts: { vaultEncryptedData?: `0x${string}` } = {}) {
  // Default vault ciphertext matches `makeGroup`'s default so the
  // ciphertext-bucket filter passes without per-test plumbing.
  const vaultEncryptedData = opts.vaultEncryptedData ?? toHex(DEFAULT_CIPHERTEXT_BYTES);
  // Route reads by functionName so tests don't break under the
  // `accessCDR` → `read` (readFee) → `collectPartials` (vaults) ordering.
  const readContract = vi.fn().mockImplementation((args: unknown) => {
    const a = args as { functionName?: string } | undefined;
    if (a?.functionName === "vaults") {
      return Promise.resolve({
        encryptedData: vaultEncryptedData,
        updatable: false,
        writeConditionAddr: "0x0",
        readConditionAddr: "0x0",
        writeConditionData: "0x",
        readConditionData: "0x",
      });
    }
    if (a?.functionName === "readFee") {
      return Promise.resolve(1n);
    }
    return Promise.resolve(undefined);
  });
  const publicClient = {
    readContract,
    getBlockNumber: vi.fn().mockResolvedValue(1000n),
  };
  const walletClient = {
    writeContract: vi.fn().mockResolvedValue("0xtxhash" as `0x${string}`),
    account: { address: "0xfeed" },
    chain: { id: 1 },
  };
  return { publicClient: publicClient as any, walletClient: walletClient as any };
}

function makeConsumer(
  observer: Observer = makeFakeObserver(),
  clientOpts: { vaultEncryptedData?: `0x${string}` } = {},
): {
  consumer: Consumer;
  publicClient: ReturnType<typeof mockClients>["publicClient"];
  walletClient: ReturnType<typeof mockClients>["walletClient"];
} {
  const { publicClient, walletClient } = mockClients(clientOpts);
  const consumer = new Consumer({
    network: "testnet",
    publicClient,
    walletClient,
    observer,
    apiUrl: API_URL,
  });
  return { consumer, publicClient, walletClient };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Consumer", () => {
  describe("constructor + simple methods", () => {
    it("constructs with required observer + apiUrl", () => {
      const { consumer } = makeConsumer();
      expect(consumer).toBeDefined();
    });

    it("prefetchRegistry calls observer.getRegisteredValidators", async () => {
      const observer = makeFakeObserver();
      const { consumer } = makeConsumer(observer);
      await consumer.prefetchRegistry();
      expect(observer.getRegisteredValidators).toHaveBeenCalledOnce();
    });

    it("read auto-fetches readFee and sends a tx", async () => {
      const { consumer, publicClient, walletClient } = makeConsumer();
      publicClient.readContract.mockResolvedValueOnce(5n);
      const result = await consumer.read({
        uuid: 42,
        accessAuxData: "0x",
        requesterPubKey: "0x04abcd" as `0x${string}`,
      });
      expect(publicClient.readContract).toHaveBeenCalledWith(
        expect.objectContaining({ functionName: "readFee" }),
      );
      expect(walletClient.writeContract).toHaveBeenCalledWith(
        expect.objectContaining({
          functionName: "read",
          args: [42, "0x", "0x04abcd"],
          value: 5n,
        }),
      );
      expect(result.txHash).toBe("0xtxhash");
    });

    it("read uses feeOverride and skips readFee fetch", async () => {
      const { consumer, publicClient, walletClient } = makeConsumer();
      await consumer.read({
        uuid: 42,
        accessAuxData: "0x",
        requesterPubKey: "0x04" as `0x${string}`,
        feeOverride: 99n,
      });
      expect(publicClient.readContract).not.toHaveBeenCalled();
      expect(walletClient.writeContract).toHaveBeenCalledWith(
        expect.objectContaining({ value: 99n }),
      );
    });
  });

  describe("collectPartials — exit conditions", () => {
    it("requires requesterPubKey", async () => {
      const { consumer } = makeConsumer();
      await expect(
        consumer.collectPartials({
          uuid: 1,
          requesterPubKey: "" as `0x${string}`,
          timeoutMs: 100,
        }),
      ).rejects.toThrow(InvalidParamsError);
    });

    it("returns submissions when length >= threshold AND thresholdMet=true", async () => {
      const { consumer } = makeConsumer(makeFakeObserver({ threshold: 2 }));
      vi.mocked(queryCDRPartials).mockResolvedValueOnce([
        makeGroup({
          submissions: [
            makeSubmission({ validator: VALIDATOR_A, pid: 1 }),
            makeSubmission({ validator: VALIDATOR_B, pid: 2 }),
          ],
          thresholdMet: true,
        }),
      ]);
      const result = await consumer.collectPartials({
        uuid: 1,
        requesterPubKey: "0x04ab" as `0x${string}`,
        timeoutMs: 1000,
        pollIntervalMs: 5,
      });
      expect(result).toHaveLength(2);
      expect(result[0].validator).toBe(VALIDATOR_A);
      expect(result[0].round).toBe(4);
      expect(result[0].uuid).toBe(1);
    });

    it("waits when thresholdMet=false even if length >= threshold", async () => {
      const { consumer } = makeConsumer(makeFakeObserver({ threshold: 2 }));
      vi.mocked(queryCDRPartials)
        .mockResolvedValueOnce([
          makeGroup({
            submissions: [
              makeSubmission({ validator: VALIDATOR_A, pid: 1 }),
              makeSubmission({ validator: VALIDATOR_B, pid: 2 }),
            ],
            thresholdMet: false,
          }),
        ])
        .mockResolvedValueOnce([
          makeGroup({
            submissions: [
              makeSubmission({ validator: VALIDATOR_A, pid: 1 }),
              makeSubmission({ validator: VALIDATOR_B, pid: 2 }),
            ],
            thresholdMet: true,
          }),
        ]);
      const result = await consumer.collectPartials({
        uuid: 1,
        requesterPubKey: "0x04" as `0x${string}`,
        timeoutMs: 1000,
        pollIntervalMs: 5,
      });
      expect(result).toHaveLength(2);
      expect(queryCDRPartials).toHaveBeenCalledTimes(2);
    });

    it("waits when length < threshold even if thresholdMet=true", async () => {
      const { consumer } = makeConsumer(makeFakeObserver({ threshold: 3 }));
      vi.mocked(queryCDRPartials)
        .mockResolvedValueOnce([
          makeGroup({
            submissions: [makeSubmission({ validator: VALIDATOR_A, pid: 1 })],
            thresholdMet: true,
          }),
        ])
        .mockResolvedValueOnce([
          makeGroup({
            submissions: [
              makeSubmission({ validator: VALIDATOR_A, pid: 1 }),
              makeSubmission({ validator: VALIDATOR_B, pid: 2 }),
              makeSubmission({ validator: VALIDATOR_C, pid: 3 }),
            ],
            thresholdMet: true,
          }),
        ]);
      const result = await consumer.collectPartials({
        uuid: 1,
        requesterPubKey: "0x04" as `0x${string}`,
        timeoutMs: 1000,
        pollIntervalMs: 5,
      });
      expect(result).toHaveLength(3);
    });

    it("returns slice(0, threshold) — extras dropped", async () => {
      const { consumer } = makeConsumer(makeFakeObserver({ threshold: 2 }));
      vi.mocked(queryCDRPartials).mockResolvedValueOnce([
        makeGroup({
          submissions: [
            makeSubmission({ validator: VALIDATOR_A, pid: 1 }),
            makeSubmission({ validator: VALIDATOR_B, pid: 2 }),
            makeSubmission({ validator: VALIDATOR_C, pid: 3 }),
          ],
          thresholdMet: true,
        }),
      ]);
      const result = await consumer.collectPartials({
        uuid: 1,
        requesterPubKey: "0x04" as `0x${string}`,
        timeoutMs: 1000,
        pollIntervalMs: 5,
      });
      expect(result).toHaveLength(2);
    });

    it("times out when threshold never reached", async () => {
      const { consumer } = makeConsumer(makeFakeObserver({ threshold: 5 }));
      vi.mocked(queryCDRPartials).mockResolvedValue([
        makeGroup({
          submissions: [makeSubmission({ validator: VALIDATOR_A, pid: 1 })],
          thresholdMet: false,
        }),
      ]);
      await expect(
        consumer.collectPartials({
          uuid: 1,
          requesterPubKey: "0x04" as `0x${string}`,
          timeoutMs: 50,
          pollIntervalMs: 5,
        }),
      ).rejects.toThrow(PartialCollectionTimeoutError);
    });

    it("treats empty groups as 'wait, may arrive later'", async () => {
      const { consumer } = makeConsumer(makeFakeObserver({ threshold: 2 }));
      vi.mocked(queryCDRPartials)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          makeGroup({
            submissions: [
              makeSubmission({ validator: VALIDATOR_A, pid: 1 }),
              makeSubmission({ validator: VALIDATOR_B, pid: 2 }),
            ],
            thresholdMet: true,
          }),
        ]);
      const result = await consumer.collectPartials({
        uuid: 1,
        requesterPubKey: "0x04" as `0x${string}`,
        timeoutMs: 1000,
        pollIntervalMs: 5,
      });
      expect(result).toHaveLength(2);
    });

    it("retries on REST errors", async () => {
      const { consumer } = makeConsumer(makeFakeObserver({ threshold: 2 }));
      vi.mocked(queryCDRPartials)
        .mockRejectedValueOnce(new Error("transient 5xx"))
        .mockResolvedValueOnce([
          makeGroup({
            submissions: [
              makeSubmission({ validator: VALIDATOR_A, pid: 1 }),
              makeSubmission({ validator: VALIDATOR_B, pid: 2 }),
            ],
            thresholdMet: true,
          }),
        ]);
      const result = await consumer.collectPartials({
        uuid: 1,
        requesterPubKey: "0x04" as `0x${string}`,
        timeoutMs: 1000,
        pollIntervalMs: 5,
      });
      expect(result).toHaveLength(2);
      expect(queryCDRPartials).toHaveBeenCalledTimes(2);
    });
  });

  describe("collectPartials — attestationConfig", () => {
    const attestations = new Map([
      [VALIDATOR_A, new Uint8Array(100).fill(0xaa)],
      [VALIDATOR_B, new Uint8Array(100).fill(0xbb)],
      [VALIDATOR_C, new Uint8Array(100).fill(0xcc)],
    ]);

    it("filters out un-trusted validators (only A trusted, threshold=2 → never met → timeout)", async () => {
      const { consumer } = makeConsumer(
        makeFakeObserver({ threshold: 2, attestations }),
      );
      // A passes, B and C fail.
      vi.mocked(verifyAttestation).mockImplementation(async (report) => ({
        valid: report[0] === 0xaa,
      }));
      vi.mocked(queryCDRPartials).mockResolvedValue([
        makeGroup({
          submissions: [
            makeSubmission({ validator: VALIDATOR_A, pid: 1 }),
            makeSubmission({ validator: VALIDATOR_B, pid: 2 }),
            makeSubmission({ validator: VALIDATOR_C, pid: 3 }),
          ],
          thresholdMet: true,
        }),
      ]);

      const onInvalidPartial = vi.fn();
      await expect(
        consumer.collectPartials({
          uuid: 1,
          requesterPubKey: "0x04" as `0x${string}`,
          timeoutMs: 50,
          pollIntervalMs: 5,
          attestationConfig: { minSecurityVersion: 1 },
          onInvalidPartial,
        }),
      ).rejects.toThrow(PartialCollectionTimeoutError);

      // Both un-trusted validators reported.
      const reported = onInvalidPartial.mock.calls.map((c) => c[0].validator);
      expect(new Set(reported)).toEqual(new Set([VALIDATOR_B, VALIDATOR_C]));
    });

    it("attestation cache: verifyAttestation called once per validator per round", async () => {
      const { consumer } = makeConsumer(
        makeFakeObserver({
          threshold: 2,
          attestations: new Map([
            [VALIDATOR_A, new Uint8Array(100).fill(0xaa)],
            [VALIDATOR_B, new Uint8Array(100).fill(0xbb)],
          ]),
        }),
      );
      vi.mocked(verifyAttestation).mockResolvedValue({ valid: true });
      // Two polls — group is at threshold on the second poll only.
      vi.mocked(queryCDRPartials)
        .mockResolvedValueOnce([
          makeGroup({
            round: 4,
            submissions: [makeSubmission({ validator: VALIDATOR_A, pid: 1 })],
            thresholdMet: false,
          }),
        ])
        .mockResolvedValueOnce([
          makeGroup({
            round: 4,
            submissions: [
              makeSubmission({ validator: VALIDATOR_A, pid: 1 }),
              makeSubmission({ validator: VALIDATOR_B, pid: 2 }),
            ],
            thresholdMet: true,
          }),
        ]);
      await consumer.collectPartials({
        uuid: 1,
        requesterPubKey: "0x04" as `0x${string}`,
        timeoutMs: 1000,
        pollIntervalMs: 5,
        attestationConfig: { minSecurityVersion: 1 },
      });
      // 2 validators × 1 attestation round = 2 calls (cache hit on 2nd poll).
      expect(verifyAttestation).toHaveBeenCalledTimes(2);
    });

    it("onInvalidPartial deduplicated by (validator, pid) across polls", async () => {
      const { consumer } = makeConsumer(
        makeFakeObserver({
          threshold: 1, // AND passes each poll, but accepted=0 < 1 → keep polling
          attestations: new Map([[VALIDATOR_A, new Uint8Array(100).fill(0xaa)]]),
        }),
      );
      vi.mocked(verifyAttestation).mockResolvedValue({ valid: false });
      vi.mocked(queryCDRPartials).mockResolvedValue([
        makeGroup({
          submissions: [
            makeSubmission({ validator: VALIDATOR_A, pid: 1 }),
          ],
          thresholdMet: true,
        }),
      ]);
      const onInvalidPartial = vi.fn();
      await expect(
        consumer.collectPartials({
          uuid: 1,
          requesterPubKey: "0x04" as `0x${string}`,
          timeoutMs: 30,
          pollIntervalMs: 5,
          attestationConfig: { minSecurityVersion: 1 },
          onInvalidPartial,
        }),
      ).rejects.toThrow(PartialCollectionTimeoutError);
      // Multiple polls × 1 submission, dedupe by (A, 1) → 1 callback total.
      expect(onInvalidPartial).toHaveBeenCalledTimes(1);
    });

    it("no attestationConfig → all submissions accepted, verifyAttestation NOT called", async () => {
      const { consumer } = makeConsumer(makeFakeObserver({ threshold: 2 }));
      vi.mocked(queryCDRPartials).mockResolvedValueOnce([
        makeGroup({
          submissions: [
            makeSubmission({ validator: VALIDATOR_A, pid: 1 }),
            makeSubmission({ validator: VALIDATOR_B, pid: 2 }),
          ],
          thresholdMet: true,
        }),
      ]);
      const result = await consumer.collectPartials({
        uuid: 1,
        requesterPubKey: "0x04" as `0x${string}`,
        timeoutMs: 1000,
        pollIntervalMs: 5,
      });
      expect(result).toHaveLength(2);
      expect(verifyAttestation).not.toHaveBeenCalled();
    });
  });

  describe("decryptDataKey", () => {
    it("ECIES-decrypts each partial then TDH2-combines", async () => {
      const { consumer } = makeConsumer();
      vi.mocked(decryptPartial).mockResolvedValue(new Uint8Array([1, 2, 3]));
      vi.mocked(tdh2Combine).mockResolvedValue(new Uint8Array([0xff]));

      const result = await consumer.decryptDataKey({
        ciphertext: { raw: new Uint8Array(), label: new Uint8Array() },
        partials: [
          {
            validator: VALIDATOR_A,
            round: 4,
            pid: 1,
            encryptedPartial: "0xab",
            ephemeralPubKey: "0xcd",
            pubShare: "0xef",
            uuid: 42,
          },
        ],
        recipientPrivKey: new Uint8Array(32),
        globalPubKey: new Uint8Array(34),
        label: new Uint8Array(32),
      });

      expect(decryptPartial).toHaveBeenCalledOnce();
      expect(tdh2Combine).toHaveBeenCalledOnce();
      expect(result).toEqual(new Uint8Array([0xff]));
    });
  });

  describe("accessCDR", () => {
    function setupAccessCDRHappyPath(threshold = 2) {
      vi.mocked(generateEphemeralKeyPair).mockReturnValue({
        privateKey: new Uint8Array(32).fill(1),
        publicKey: new Uint8Array(65).fill(2),
      });
      const observer = makeFakeObserver({
        threshold,
        globalPubKey: new Uint8Array(34).fill(0xaa),
      });
      // mockClients defaults vault.encryptedData to `toHex(DEFAULT_CIPHERTEXT_BYTES)`,
      // which matches makeGroup's default ciphertext, so the ciphertext-bucket
      // filter passes without explicit per-call setup.
      const { consumer } = makeConsumer(observer);
      vi.mocked(queryCDRPartials).mockResolvedValue([
        makeGroup({
          submissions: [
            makeSubmission({ validator: VALIDATOR_A, pid: 1 }),
            makeSubmission({ validator: VALIDATOR_B, pid: 2 }),
          ],
          thresholdMet: true,
        }),
      ]);
      vi.mocked(decryptPartial).mockResolvedValue(new Uint8Array([1]));
      vi.mocked(tdh2Combine).mockResolvedValue(new Uint8Array([0xff]));
      return { consumer, observer };
    }

    it("happy path: auto-generates ephemeral keypair, recovers dataKey, returns txHash", async () => {
      const { consumer } = setupAccessCDRHappyPath();
      const result = await consumer.accessCDR({
        uuid: 42,
        accessAuxData: "0x",
        timeoutMs: 1000,
      });
      expect(generateEphemeralKeyPair).toHaveBeenCalled();
      expect(result.dataKey).toEqual(new Uint8Array([0xff]));
      expect(result.txHash).toBe("0xtxhash");
    });

    it("throws when requesterPubKey provided without recipientPrivKey", async () => {
      const { consumer } = makeConsumer();
      await expect(
        consumer.accessCDR({
          uuid: 1,
          accessAuxData: "0x",
          requesterPubKey: "0x04" as `0x${string}`,
        }),
      ).rejects.toThrow(InvalidParamsError);
    });

    it("throws when recipientPrivKey provided without requesterPubKey", async () => {
      const { consumer } = makeConsumer();
      await expect(
        consumer.accessCDR({
          uuid: 1,
          accessAuxData: "0x",
          recipientPrivKey: new Uint8Array(32),
        }),
      ).rejects.toThrow(InvalidParamsError);
    });

    it("zeroes ephemeral recipientPrivKey after use", async () => {
      const { consumer } = setupAccessCDRHappyPath();
      await consumer.accessCDR({
        uuid: 42,
        accessAuxData: "0x",
        timeoutMs: 1000,
      });
      // generateEphemeralKeyPair mock returns a Uint8Array(32).fill(1).
      // After accessCDR, it should be zeroed.
      const generated = vi.mocked(generateEphemeralKeyPair).mock.results[0]
        .value as { privateKey: Uint8Array; publicKey: Uint8Array };
      expect(generated.privateKey.every((b) => b === 0)).toBe(true);
    });

    it("uses provided globalPubKey: skips observer.getGlobalPubKey", async () => {
      // observer.getThresholdAt is called once from collectPartials (it
      // derives the bucket-round threshold). observer.getThreshold (the
      // active-round variant) must NOT be called from collectPartials —
      // those are now distinct methods.
      vi.mocked(generateEphemeralKeyPair).mockReturnValue({
        privateKey: new Uint8Array(32).fill(1),
        publicKey: new Uint8Array(65).fill(2),
      });
      const observer = makeFakeObserver();
      const { consumer } = makeConsumer(observer);
      vi.mocked(queryCDRPartials).mockResolvedValue([
        makeGroup({
          submissions: [
            makeSubmission({ validator: VALIDATOR_A, pid: 1 }),
            makeSubmission({ validator: VALIDATOR_B, pid: 2 }),
          ],
          thresholdMet: true,
        }),
      ]);
      vi.mocked(decryptPartial).mockResolvedValue(new Uint8Array([1]));
      vi.mocked(tdh2Combine).mockResolvedValue(new Uint8Array([0xff]));

      await consumer.accessCDR({
        uuid: 42,
        accessAuxData: "0x",
        globalPubKey: new Uint8Array(34).fill(0xcc),
        timeoutMs: 1000,
      });
      expect(observer.getGlobalPubKey).not.toHaveBeenCalled();
      expect(observer.getThresholdAt).toHaveBeenCalledTimes(1);
      expect(observer.getThresholdAt).toHaveBeenCalledWith(4);
      expect(observer.getThreshold).not.toHaveBeenCalled();
    });

    it("throws EmptyVaultError BEFORE submitting any tx — no fee paid for empty vault (#78)", async () => {
      const observer = makeFakeObserver();
      const { consumer, walletClient } = makeConsumer(observer, {
        vaultEncryptedData: "0x",
      });

      await expect(
        consumer.accessCDR({
          uuid: 999,
          accessAuxData: "0x",
          timeoutMs: 100,
        }),
      ).rejects.toThrow(EmptyVaultError);

      // Critical regression assertion: the preflight must run BEFORE any
      // fee-bearing read tx is submitted. If `read()` is called before the
      // empty check, the user pays for a request that can never succeed.
      expect(walletClient.writeContract).not.toHaveBeenCalled();
      // Also: the partial poll must never start.
      expect(queryCDRPartials).not.toHaveBeenCalled();
    });

    it("pins one vault snapshot for the whole flow — concurrent update doesn't shift the filter (#79)", async () => {
      vi.mocked(generateEphemeralKeyPair).mockReturnValue({
        privateKey: new Uint8Array(32).fill(1),
        publicKey: new Uint8Array(65).fill(2),
      });
      const observer = makeFakeObserver({
        threshold: 2,
        globalPubKey: new Uint8Array(34).fill(0xaa),
      });
      const { consumer, publicClient } = makeConsumer(observer);

      // Simulate a concurrent vault update: the first vault read (preflight)
      // returns ciphertext C1; any subsequent vault read would return C2.
      // With #79's fix, the SDK reuses the preflight snapshot across the
      // whole `accessCDR` call, so the vault is read exactly once and the
      // filter pins to C1 — matching the keeper's bucket. Without the fix,
      // a second read inside `collectPartials` would shift the filter to
      // C2 and the call would time out.
      let vaultReadCount = 0;
      publicClient.readContract.mockImplementation((args: unknown) => {
        const a = args as { functionName?: string };
        if (a?.functionName === "vaults") {
          vaultReadCount++;
          return Promise.resolve({
            encryptedData: vaultReadCount === 1 ? "0x01" : "0x02",
            updatable: true,
            writeConditionAddr: "0x0",
            readConditionAddr: "0x0",
            writeConditionData: "0x",
            readConditionData: "0x",
          });
        }
        if (a?.functionName === "readFee") return Promise.resolve(1n);
        return Promise.resolve(undefined);
      });

      // Keeper produced partials for the original ciphertext (C1 = 0x01),
      // matching what was on chain at read-tx-block time.
      vi.mocked(queryCDRPartials).mockResolvedValue([
        makeGroup({
          ciphertext: new Uint8Array([0x01]),
          submissions: [
            makeSubmission({
              validator: VALIDATOR_A,
              pid: 1,
              ciphertext: new Uint8Array([0x01]),
            }),
            makeSubmission({
              validator: VALIDATOR_B,
              pid: 2,
              ciphertext: new Uint8Array([0x01]),
            }),
          ],
          thresholdMet: true,
        }),
      ]);
      vi.mocked(decryptPartial).mockResolvedValue(new Uint8Array([1]));
      vi.mocked(tdh2Combine).mockResolvedValue(new Uint8Array([0xff]));

      const result = await consumer.accessCDR({
        uuid: 42,
        accessAuxData: "0x",
        timeoutMs: 1000,
      });

      expect(result.dataKey).toEqual(new Uint8Array([0xff]));
      // Critical regression assertion: vault is read EXACTLY once. Two
      // reads would mean accessCDR + collectPartials each loaded the
      // vault separately, and the filter would pin C2 instead of C1.
      expect(vaultReadCount).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // collectPartials: bucket-by-ciphertext + bucket-round-threshold (#75 / #76)
  // -------------------------------------------------------------------------
  describe("collectPartials — bucket selection by (round, ciphertext)", () => {
    it("filters multi-group response by vault ciphertext, picks the matching bucket (#75)", async () => {
      const VAULT_CIPHERTEXT = new Uint8Array([0xa1, 0xa2]);
      const STALE_CIPHERTEXT = new Uint8Array([0xb1, 0xb2]);
      const observer = makeFakeObserver({ threshold: 2 });
      const { consumer } = makeConsumer(observer, {
        vaultEncryptedData: toHex(VAULT_CIPHERTEXT),
      });

      // Two groups: a stale (older, different ciphertext) bucket and the
      // current vault's bucket. Without #75's filter the SDK would pick the
      // stale one (ascending round sort makes it appear first) and decrypt
      // garbage.
      vi.mocked(queryCDRPartials).mockResolvedValueOnce([
        makeGroup({
          round: 10,
          ciphertext: STALE_CIPHERTEXT,
          submissions: [
            makeSubmission({ validator: VALIDATOR_A, pid: 1, round: 10, ciphertext: STALE_CIPHERTEXT }),
            makeSubmission({ validator: VALIDATOR_B, pid: 2, round: 10, ciphertext: STALE_CIPHERTEXT }),
          ],
          thresholdMet: true,
        }),
        makeGroup({
          round: 11,
          ciphertext: VAULT_CIPHERTEXT,
          submissions: [
            makeSubmission({ validator: VALIDATOR_A, pid: 1, round: 11, ciphertext: VAULT_CIPHERTEXT }),
            makeSubmission({ validator: VALIDATOR_B, pid: 2, round: 11, ciphertext: VAULT_CIPHERTEXT }),
          ],
          thresholdMet: true,
        }),
      ]);

      const result = await consumer.collectPartials({
        uuid: 1,
        requesterPubKey: "0x04ab" as `0x${string}`,
        timeoutMs: 1000,
        pollIntervalMs: 5,
      });

      expect(result).toHaveLength(2);
      // All returned events must be from the matching (round=11) bucket.
      expect(result.every((p) => p.round === 11)).toBe(true);
      expect(result.every((p) => p.ciphertext === toHex(VAULT_CIPHERTEXT))).toBe(true);
    });

    it("polls past stale-only buckets and returns when the matching bucket fills (#75)", async () => {
      const VAULT_CIPHERTEXT = new Uint8Array([0xa1, 0xa2]);
      const STALE_CIPHERTEXT = new Uint8Array([0xb1, 0xb2]);
      const observer = makeFakeObserver({ threshold: 2 });
      const { consumer } = makeConsumer(observer, {
        vaultEncryptedData: toHex(VAULT_CIPHERTEXT),
      });

      // Tick 1: only stale bucket has submissions → keep waiting.
      // Tick 2: matching bucket fills → return.
      vi.mocked(queryCDRPartials)
        .mockResolvedValueOnce([
          makeGroup({
            round: 10,
            ciphertext: STALE_CIPHERTEXT,
            submissions: [
              makeSubmission({ validator: VALIDATOR_A, pid: 1, round: 10, ciphertext: STALE_CIPHERTEXT }),
              makeSubmission({ validator: VALIDATOR_B, pid: 2, round: 10, ciphertext: STALE_CIPHERTEXT }),
            ],
            thresholdMet: true,
          }),
        ])
        .mockResolvedValueOnce([
          makeGroup({
            round: 10,
            ciphertext: STALE_CIPHERTEXT,
            submissions: [],
            thresholdMet: false,
          }),
          makeGroup({
            round: 11,
            ciphertext: VAULT_CIPHERTEXT,
            submissions: [
              makeSubmission({ validator: VALIDATOR_A, pid: 1, round: 11, ciphertext: VAULT_CIPHERTEXT }),
              makeSubmission({ validator: VALIDATOR_B, pid: 2, round: 11, ciphertext: VAULT_CIPHERTEXT }),
            ],
            thresholdMet: true,
          }),
        ]);

      const result = await consumer.collectPartials({
        uuid: 1,
        requesterPubKey: "0x04ab" as `0x${string}`,
        timeoutMs: 1000,
        pollIntervalMs: 5,
      });

      expect(result).toHaveLength(2);
      expect(result.every((p) => p.round === 11)).toBe(true);
      expect(queryCDRPartials).toHaveBeenCalledTimes(2);
    });

    it("times out when no group ever matches the vault ciphertext (#75)", async () => {
      const VAULT_CIPHERTEXT = new Uint8Array([0xa1, 0xa2]);
      const STALE_CIPHERTEXT = new Uint8Array([0xb1, 0xb2]);
      const observer = makeFakeObserver({ threshold: 2 });
      const { consumer } = makeConsumer(observer, {
        vaultEncryptedData: toHex(VAULT_CIPHERTEXT),
      });

      vi.mocked(queryCDRPartials).mockResolvedValue([
        makeGroup({
          round: 10,
          ciphertext: STALE_CIPHERTEXT,
          submissions: [
            makeSubmission({ validator: VALIDATOR_A, pid: 1, round: 10, ciphertext: STALE_CIPHERTEXT }),
            makeSubmission({ validator: VALIDATOR_B, pid: 2, round: 10, ciphertext: STALE_CIPHERTEXT }),
          ],
          thresholdMet: true,
        }),
      ]);

      await expect(
        consumer.collectPartials({
          uuid: 1,
          requesterPubKey: "0x04ab" as `0x${string}`,
          timeoutMs: 30,
          pollIntervalMs: 5,
        }),
      ).rejects.toThrow(PartialCollectionTimeoutError);
    });

    it("when multiple buckets match the same ciphertext, prefers the highest round", async () => {
      const VAULT_CIPHERTEXT = new Uint8Array([0xa1, 0xa2]);
      const observer = makeFakeObserver({ threshold: 2 });
      const { consumer } = makeConsumer(observer, {
        vaultEncryptedData: toHex(VAULT_CIPHERTEXT),
      });

      vi.mocked(queryCDRPartials).mockResolvedValueOnce([
        makeGroup({
          round: 10,
          ciphertext: VAULT_CIPHERTEXT,
          submissions: [
            makeSubmission({ validator: VALIDATOR_A, pid: 1, round: 10, ciphertext: VAULT_CIPHERTEXT }),
            makeSubmission({ validator: VALIDATOR_B, pid: 2, round: 10, ciphertext: VAULT_CIPHERTEXT }),
          ],
          thresholdMet: true,
        }),
        makeGroup({
          round: 11,
          ciphertext: VAULT_CIPHERTEXT,
          submissions: [
            makeSubmission({ validator: VALIDATOR_A, pid: 1, round: 11, ciphertext: VAULT_CIPHERTEXT }),
            makeSubmission({ validator: VALIDATOR_B, pid: 2, round: 11, ciphertext: VAULT_CIPHERTEXT }),
          ],
          thresholdMet: true,
        }),
      ]);

      const result = await consumer.collectPartials({
        uuid: 1,
        requesterPubKey: "0x04ab" as `0x${string}`,
        timeoutMs: 1000,
        pollIntervalMs: 5,
      });

      expect(result).toHaveLength(2);
      expect(result.every((p) => p.round === 11)).toBe(true);
    });

    it("uses the bucket's round threshold via getThresholdAt — bucket complete even when active round threshold is higher (#76)", async () => {
      // Round 10 has threshold 2 (bucket's round); round 11 (active) has
      // threshold 3. Without #76, getThreshold() would return 3 and the SDK
      // would keep waiting on a 2/2 bucket. With #76, getThresholdAt(10)
      // returns 2 and the SDK returns immediately.
      const observer = makeFakeObserver({
        thresholdAt: (round) => (round === 10 ? 2 : 3),
      });
      const { consumer } = makeConsumer(observer);

      vi.mocked(queryCDRPartials).mockResolvedValueOnce([
        makeGroup({
          round: 10,
          submissions: [
            makeSubmission({ validator: VALIDATOR_A, pid: 1, round: 10 }),
            makeSubmission({ validator: VALIDATOR_B, pid: 2, round: 10 }),
          ],
          threshold: 2,
          thresholdMet: true,
        }),
      ]);

      const result = await consumer.collectPartials({
        uuid: 1,
        requesterPubKey: "0x04ab" as `0x${string}`,
        timeoutMs: 1000,
        pollIntervalMs: 5,
      });

      expect(result).toHaveLength(2);
      expect(observer.getThresholdAt).toHaveBeenCalledWith(10);
      // getThreshold (active-round) must not be called from collectPartials.
      expect(observer.getThreshold).not.toHaveBeenCalled();
    });

    it("throws EmptyVaultError when vault has no encryptedData", async () => {
      const observer = makeFakeObserver({ threshold: 2 });
      const { consumer } = makeConsumer(observer, { vaultEncryptedData: "0x" });

      await expect(
        consumer.collectPartials({
          uuid: 1,
          requesterPubKey: "0x04ab" as `0x${string}`,
          timeoutMs: 100,
          pollIntervalMs: 5,
        }),
      ).rejects.toThrow(EmptyVaultError);
      // Should not even poll the REST endpoint — fail fast.
      expect(queryCDRPartials).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // registryStatus state machine (#56 2.5)
  // -------------------------------------------------------------------------
  describe("registryStatus", () => {
    it("starts in 'unbuilt'", () => {
      const { consumer } = makeConsumer();
      expect(consumer.registryStatus).toBe("unbuilt");
    });

    it("moves to 'ready' after a successful prefetchRegistry", async () => {
      const observer = makeFakeObserver();
      const { consumer } = makeConsumer(observer);
      await consumer.prefetchRegistry();
      expect(consumer.registryStatus).toBe("ready");
    });

    it("moves to 'failed' when prefetchRegistry rejects, and back to 'building' on retry", async () => {
      const observer = makeFakeObserver();
      vi.mocked(observer.getRegisteredValidators)
        .mockRejectedValueOnce(new Error("network down"))
        .mockResolvedValueOnce(new Map());
      const { consumer } = makeConsumer(observer);

      await expect(consumer.prefetchRegistry()).rejects.toThrow("network down");
      expect(consumer.registryStatus).toBe("failed");

      // Retry: the immediate transition is 'building' (we observe it via the
      // in-flight Promise), and the resolved state is 'ready'.
      const retry = consumer.prefetchRegistry();
      expect(consumer.registryStatus).toBe("building");
      await retry;
      expect(consumer.registryStatus).toBe("ready");
    });
  });

  // -------------------------------------------------------------------------
  // read() balance preflight (#56 2.6)
  // -------------------------------------------------------------------------
  describe("read balance preflight", () => {
    it("skips preflight when publicClient has no getBalance method", async () => {
      const { consumer, publicClient, walletClient } = makeConsumer();
      // Default mock has no getBalance — read should succeed.
      publicClient.readContract.mockResolvedValueOnce(5n);
      await consumer.read({
        uuid: 42,
        accessAuxData: "0x",
        requesterPubKey: "0x04abcd" as `0x${string}`,
      });
      expect(walletClient.writeContract).toHaveBeenCalledOnce();
    });

    it("throws InsufficientBalanceError when balance < fee and tx is NOT sent", async () => {
      const { consumer, publicClient, walletClient } = makeConsumer();
      publicClient.readContract.mockResolvedValueOnce(100n); // fee = 100
      publicClient.getBalance = vi.fn().mockResolvedValue(50n); // wallet has 50

      await expect(
        consumer.read({
          uuid: 1,
          accessAuxData: "0x",
          requesterPubKey: "0x04" as `0x${string}`,
        }),
      ).rejects.toThrow(InsufficientBalanceError);

      expect(walletClient.writeContract).not.toHaveBeenCalled();
    });

    it("passes preflight when balance >= fee and proceeds to send the tx", async () => {
      const { consumer, publicClient, walletClient } = makeConsumer();
      publicClient.readContract.mockResolvedValueOnce(100n);
      publicClient.getBalance = vi.fn().mockResolvedValue(100n); // exact

      const result = await consumer.read({
        uuid: 1,
        accessAuxData: "0x",
        requesterPubKey: "0x04" as `0x${string}`,
      });

      expect(publicClient.getBalance).toHaveBeenCalledWith({
        address: walletClient.account.address,
      });
      expect(walletClient.writeContract).toHaveBeenCalledOnce();
      expect(result.txHash).toBe("0xtxhash");
    });

    it("propagates getBalance failures and does not send the tx", async () => {
      const { consumer, publicClient, walletClient } = makeConsumer();
      publicClient.readContract.mockResolvedValueOnce(100n);
      publicClient.getBalance = vi.fn().mockRejectedValue(new Error("rpc down"));

      await expect(
        consumer.read({
          uuid: 1,
          accessAuxData: "0x",
          requesterPubKey: "0x04" as `0x${string}`,
        }),
      ).rejects.toThrow("rpc down");

      expect(walletClient.writeContract).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Logger plumbing (#56 2.3)
  // -------------------------------------------------------------------------
  describe("logger", () => {
    function makeLogger(): CDRLogger & { calls: Array<[string, string, unknown?]> } {
      const calls: Array<[string, string, unknown?]> = [];
      return {
        calls,
        debug: (msg, ctx) => { calls.push(["debug", msg, ctx]); },
        info:  (msg, ctx) => { calls.push(["info",  msg, ctx]); },
        warn:  (msg, ctx) => { calls.push(["warn",  msg, ctx]); },
        error: (msg, ctx) => { calls.push(["error", msg, ctx]); },
      };
    }

    it("emits registry.prefetch.start + ready around a successful prefetch", async () => {
      const observer = makeFakeObserver();
      const { publicClient, walletClient } = mockClients();
      const logger = makeLogger();
      const consumer = new Consumer({
        network: "testnet",
        publicClient,
        walletClient,
        observer,
        apiUrl: API_URL,
        logger,
      });
      await consumer.prefetchRegistry();
      const events = logger.calls.map(([, msg]) => msg);
      expect(events).toContain("registry.prefetch.start");
      expect(events).toContain("registry.prefetch.ready");
    });

    it("emits read.tx.sent on success", async () => {
      const observer = makeFakeObserver();
      const { publicClient, walletClient } = mockClients();
      publicClient.readContract.mockResolvedValueOnce(5n);
      const logger = makeLogger();
      const consumer = new Consumer({
        network: "testnet",
        publicClient,
        walletClient,
        observer,
        apiUrl: API_URL,
        logger,
      });
      await consumer.read({
        uuid: 42,
        accessAuxData: "0x",
        requesterPubKey: "0x04" as `0x${string}`,
      });
      const events = logger.calls.map(([, msg]) => msg);
      expect(events).toContain("read.tx.sent");
      const sent = logger.calls.find(([, msg]) => msg === "read.tx.sent");
      expect(sent?.[2]).toMatchObject({ fee: "5" });
    });

    it("emits read.preflight.insufficient_balance when balance < fee", async () => {
      const observer = makeFakeObserver();
      const { publicClient, walletClient } = mockClients();
      publicClient.readContract.mockResolvedValueOnce(100n);
      publicClient.getBalance = vi.fn().mockResolvedValue(0n);
      const logger = makeLogger();
      const consumer = new Consumer({
        network: "testnet",
        publicClient,
        walletClient,
        observer,
        apiUrl: API_URL,
        logger,
      });
      await expect(
        consumer.read({
          uuid: 1,
          accessAuxData: "0x",
          requesterPubKey: "0x04" as `0x${string}`,
        }),
      ).rejects.toThrow(InsufficientBalanceError);
      const events = logger.calls.map(([, msg]) => msg);
      expect(events).toContain("read.preflight.insufficient_balance");
      const insufficient = logger.calls.find(([, msg]) => (
        msg === "read.preflight.insufficient_balance"
      ));
      expect(insufficient?.[2]).toMatchObject({ balance: "0", required: "100" });
    });

    it("emits read.preflight.failed when getBalance rejects", async () => {
      const observer = makeFakeObserver();
      const { publicClient, walletClient } = mockClients();
      publicClient.readContract.mockResolvedValueOnce(100n);
      publicClient.getBalance = vi.fn().mockRejectedValue(new Error("rpc down"));
      const logger = makeLogger();
      const consumer = new Consumer({
        network: "testnet",
        publicClient,
        walletClient,
        observer,
        apiUrl: API_URL,
        logger,
      });

      await expect(
        consumer.read({
          uuid: 1,
          accessAuxData: "0x",
          requesterPubKey: "0x04" as `0x${string}`,
        }),
      ).rejects.toThrow("rpc down");

      const events = logger.calls.map(([, msg]) => msg);
      expect(events).toContain("read.preflight.failed");
    });
  });

  // -------------------------------------------------------------------------
  // InvalidPartialError surfaces to onInvalidPartial (#56 2.2)
  // -------------------------------------------------------------------------
  describe("onInvalidPartial receives typed InvalidPartialError", () => {
    it("reports rejected partials with .code === 'INVALID_PARTIAL'", async () => {
      const VAULT_CIPHERTEXT = new Uint8Array([0xc1, 0xc2]);
      const observer = makeFakeObserver({ threshold: 2 });
      const { consumer } = makeConsumer(observer, {
        vaultEncryptedData: toHex(VAULT_CIPHERTEXT),
      });

      // VALIDATOR_A's attestation passes; VALIDATOR_B's fails. We use a
      // 3-of-3 group so the trust set has to filter B out before the
      // bucket can clear threshold.
      vi.mocked(verifyAttestation).mockImplementation(async (report: Uint8Array) => {
        const isA = report[0] === 0xaa;
        return { valid: isA };
      });

      vi.mocked(observer.getValidatorAttestations).mockResolvedValue(
        new Map<string, Uint8Array>([
          [VALIDATOR_A, new Uint8Array([0xaa])],
          [VALIDATOR_B, new Uint8Array([0xbb])],
          [VALIDATOR_C, new Uint8Array([0xaa])],
        ]),
      );

      vi.mocked(queryCDRPartials).mockResolvedValueOnce([
        makeGroup({
          round: 4,
          ciphertext: VAULT_CIPHERTEXT,
          submissions: [
            makeSubmission({ validator: VALIDATOR_A, pid: 1, ciphertext: VAULT_CIPHERTEXT }),
            makeSubmission({ validator: VALIDATOR_B, pid: 2, ciphertext: VAULT_CIPHERTEXT }),
            makeSubmission({ validator: VALIDATOR_C, pid: 3, ciphertext: VAULT_CIPHERTEXT }),
          ],
          thresholdMet: true,
        }),
      ]);

      const reported: Error[] = [];
      const result = await consumer.collectPartials({
        uuid: 7,
        requesterPubKey: "0x04ab" as `0x${string}`,
        timeoutMs: 200,
        pollIntervalMs: 5,
        attestationConfig: { minSecurityVersion: 1 },
        onInvalidPartial: (_event, err) => reported.push(err),
      });

      expect(result).toHaveLength(2);
      expect(reported).toHaveLength(1);
      const err = reported[0] as InvalidPartialError;
      expect(err).toBeInstanceOf(InvalidPartialError);
      expect(err.code).toBe("INVALID_PARTIAL");
      expect(err.validator).toBe(VALIDATOR_B);
      expect(err.pid).toBe(2);
      expect(err.reason).toBe("attestation rejected");
    });
  });
});
