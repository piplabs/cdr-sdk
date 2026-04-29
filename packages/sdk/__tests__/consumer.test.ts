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
} from "../src/errors.js";
import type { Observer } from "../src/observer.js";
import type { DKGPartialDecryptionSubmission } from "../src/story-api/types.js";

const API_URL = "http://test:1317";
const VALIDATOR_A = "0x0000000000000000000000000000000000000001" as const;
const VALIDATOR_B = "0x0000000000000000000000000000000000000002" as const;
const VALIDATOR_C = "0x0000000000000000000000000000000000000003" as const;

function makeFakeObserver(opts: {
  threshold?: number;
  registrations?: Map<string, Uint8Array>;
  attestations?: Map<string, Uint8Array>;
  globalPubKey?: Uint8Array;
} = {}): Observer {
  return {
    getThreshold: vi.fn().mockResolvedValue(opts.threshold ?? 2),
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

function makeSubmission(opts: {
  validator: `0x${string}`;
  pid: number;
  round?: number;
}): DKGPartialDecryptionSubmission {
  return {
    validator: opts.validator,
    round: opts.round ?? 4,
    pid: opts.pid,
    encryptedPartial: new Uint8Array([1, 2, 3]),
    ephemeralPubKey: new Uint8Array(65).fill(0xaa),
    pubShare: new Uint8Array(34).fill(0xbb),
    ciphertext: new Uint8Array([0xcc]),
    label: new Uint8Array(32).fill(0xdd),
  };
}

function makeGroup(opts: {
  round?: number;
  submissions: DKGPartialDecryptionSubmission[];
  thresholdMet?: boolean;
}) {
  return {
    round: opts.round ?? 4,
    submissions: opts.submissions,
    ciphertext: new Uint8Array([0x01]),
    threshold: 2,
    thresholdMet: opts.thresholdMet ?? true,
  };
}

function mockClients() {
  const publicClient = {
    readContract: vi.fn(),
    getBlockNumber: vi.fn().mockResolvedValue(1000n),
  };
  const walletClient = {
    writeContract: vi.fn().mockResolvedValue("0xtxhash" as `0x${string}`),
    account: { address: "0xfeed" },
    chain: { id: 1 },
  };
  return { publicClient: publicClient as any, walletClient: walletClient as any };
}

function makeConsumer(observer: Observer = makeFakeObserver()): {
  consumer: Consumer;
  publicClient: ReturnType<typeof mockClients>["publicClient"];
  walletClient: ReturnType<typeof mockClients>["walletClient"];
} {
  const { publicClient, walletClient } = mockClients();
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
      const { consumer, publicClient } = makeConsumer(observer);
      publicClient.readContract
        .mockResolvedValueOnce({
          encryptedData: "0x",
          updatable: false,
          writeConditionAddr: "0x0",
          readConditionAddr: "0x0",
          writeConditionData: "0x",
          readConditionData: "0x",
        })
        .mockResolvedValueOnce(1n);
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
      // observer.getThreshold is still called once from collectPartials
      // (it derives sdkThreshold internally) — that's expected and
      // independent of accessCDR's globalPubKey shortcut.
      vi.mocked(generateEphemeralKeyPair).mockReturnValue({
        privateKey: new Uint8Array(32).fill(1),
        publicKey: new Uint8Array(65).fill(2),
      });
      const observer = makeFakeObserver();
      const { consumer, publicClient } = makeConsumer(observer);
      publicClient.readContract
        .mockResolvedValueOnce({
          encryptedData: "0x",
          updatable: false,
          writeConditionAddr: "0x0",
          readConditionAddr: "0x0",
          writeConditionData: "0x",
          readConditionData: "0x",
        })
        .mockResolvedValueOnce(1n);
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
      // observer.getThreshold gets called exactly once from collectPartials.
      expect(observer.getThreshold).toHaveBeenCalledTimes(1);
    });
  });
});
