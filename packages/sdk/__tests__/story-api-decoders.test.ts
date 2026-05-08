import { describe, it, expect } from "vitest";
import {
  decodeDKGNetwork,
  decodeDKGRegistration,
  decodeSubmission,
  decodeSubmissionsByRound,
  type RawDKGNetwork,
  type RawDKGRegistration,
  type RawSubmission,
  type RawSubmissionsByRound,
} from "../src/story-api/decoders.js";
import { IncompleteDKGNetworkError } from "../src/story-api/errors.js";
import { bytesToHex } from "../src/story-api/bytes.js";

describe("story-api/decoders", () => {
  describe("decodeDKGNetwork", () => {
    const raw: RawDKGNetwork = {
      round: 6,
      start_block_height: "1331",
      start_block_hash: "Lmkutr5aA5HeGloLDbs4HU0+HjpJqgTCRCNzuU63CY0=",
      active_val_set: [
        // Mixed-case input — should be lowercased.
        "0xA5d284381bB6905C6954802F1fc22C84E7d15Df6",
        "0xc025e30e4ff0a68cb623ac671933b6fe99ef7cc7",
      ],
      total: 3,
      threshold: 2,
      stage: 4,
      is_resharing: true,
      global_public_key: "g8P8NKJWH/7pqNQZYpuDMGYQ1PMdOd5j/uOLaxBHfTc=",
      public_coeffs: [
        "g8P8NKJWH/7pqNQZYpuDMGYQ1PMdOd5j/uOLaxBHfTc=",
        "lTR3+aOflQmWzPVxFqy+e/0j47gZzbc5yJHN6E5jHP8=",
      ],
    };

    it("maps snake_case keys to camelCase fields", () => {
      const decoded = decodeDKGNetwork(raw);
      expect(decoded.round).toBe(6);
      expect(decoded.startBlockHeight).toBe(1331n);
      expect(decoded.startBlockHash).toBeInstanceOf(Uint8Array);
      expect(decoded.activeValSet).toBeInstanceOf(Array);
      expect(decoded.total).toBe(3);
      expect(decoded.threshold).toBe(2);
      expect(decoded.stage).toBe(4);
      expect(decoded.isResharing).toBe(true);
      expect(decoded.globalPublicKey).toBeInstanceOf(Uint8Array);
      expect(decoded.publicCoeffs).toBeInstanceOf(Array);
    });

    it("parses startBlockHeight as bigint (not number)", () => {
      const decoded = decodeDKGNetwork(raw);
      expect(typeof decoded.startBlockHeight).toBe("bigint");
      expect(decoded.startBlockHeight).toBe(1331n);
    });

    it("preserves block heights exceeding Number.MAX_SAFE_INTEGER", () => {
      const big = "9007199254740993"; // 2^53 + 1
      const decoded = decodeDKGNetwork({ ...raw, start_block_height: big });
      expect(decoded.startBlockHeight).toBe(9007199254740993n);
    });

    it("decodes globalPublicKey base64 to a 32-byte Uint8Array", () => {
      const decoded = decodeDKGNetwork(raw);
      expect(decoded.globalPublicKey.length).toBe(32);
      expect(bytesToHex(decoded.globalPublicKey)).toBe(
        "83c3fc34a2561ffee9a8d419629b83306610d4f31d39de63fee38b6b10477d37",
      );
    });

    it("lowercases activeValSet addresses", () => {
      const decoded = decodeDKGNetwork(raw);
      expect(decoded.activeValSet[0]).toBe(
        "0xa5d284381bb6905c6954802f1fc22c84e7d15df6",
      );
      expect(decoded.activeValSet[1]).toBe(
        "0xc025e30e4ff0a68cb623ac671933b6fe99ef7cc7",
      );
    });

    it("publicCoeffs length matches threshold", () => {
      const decoded = decodeDKGNetwork(raw);
      expect(decoded.publicCoeffs.length).toBe(decoded.threshold);
    });

    it("decodes startBlockHash to 32-byte Uint8Array", () => {
      const decoded = decodeDKGNetwork(raw);
      expect(decoded.startBlockHash.length).toBe(32);
    });

    it("throws IncompleteDKGNetworkError when global_public_key is missing (Failed-stage payload)", () => {
      const failed: RawDKGNetwork = {
        ...raw,
        stage: 5, // Failed
        global_public_key: undefined,
        public_coeffs: undefined,
      };
      expect(() => decodeDKGNetwork(failed)).toThrow(IncompleteDKGNetworkError);
    });

    it("error carries round, stage, and the full list of missing fields", () => {
      const dealing: RawDKGNetwork = {
        ...raw,
        round: 17,
        stage: 2, // Dealing
        global_public_key: undefined,
        public_coeffs: undefined,
        active_val_set: undefined,
      };
      try {
        decodeDKGNetwork(dealing);
        throw new Error("expected throw");
      } catch (e) {
        expect(e).toBeInstanceOf(IncompleteDKGNetworkError);
        const err = e as IncompleteDKGNetworkError;
        expect(err.round).toBe(17);
        expect(err.stage).toBe(2);
        expect([...err.missingFields].sort()).toEqual(
          ["active_val_set", "global_public_key", "public_coeffs"].sort(),
        );
      }
    });

    it("does not throw when stage is non-stable but all fields are populated", () => {
      // Defensive: keeper behavior is empirical, not contractual. If a future
      // keeper version surfaces full fields for a Failed round, accept it.
      const decoded = decodeDKGNetwork({ ...raw, stage: 5 });
      expect(decoded.stage).toBe(5);
      expect(decoded.globalPublicKey).toBeInstanceOf(Uint8Array);
    });
  });

  describe("decodeDKGRegistration", () => {
    const verifiedRaw: RawDKGRegistration = {
      round: 6,
      validator_addr: "0xA5D284381bB6905C6954802F1fc22C84E7d15Df6",
      index: 1,
      dkg_pub_key: "mTL7rsdEZSON66bC97qrtAq4in0hmAZzIJRPTpoqHU4=",
      comm_pub_key:
        "YTg83sfKrkSVfFYwYhXGZNzKWIH++4lPuzVA0wdNxsXqOPB8wKMK6kP+38xV0DvWaUGRqBUYqW2P/iJUmoFGgQ==",
      enclave_report: "AwACAAAAAAALABAAk5pyMw==",
      status: 1, // Verified
      code_commitment: "Kchx",
      enclave_type: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE=",
    };

    it("decodes a verified-status registration without pubKeyShare", () => {
      const decoded = decodeDKGRegistration(verifiedRaw);
      expect(decoded.round).toBe(6);
      expect(decoded.validatorAddr).toBe(
        "0xa5d284381bb6905c6954802f1fc22c84e7d15df6",
      );
      expect(decoded.index).toBe(1);
      expect(decoded.commPubKey).toBeInstanceOf(Uint8Array);
      expect(decoded.dkgPubKey).toBeInstanceOf(Uint8Array);
      expect(decoded.pubKeyShare).toBeUndefined();
      expect(decoded.enclaveReport).toBeInstanceOf(Uint8Array);
      expect(decoded.status).toBe(1);
    });

    it("decodes pubKeyShare when present (Finalized status)", () => {
      const finalizedRaw: RawDKGRegistration = {
        ...verifiedRaw,
        status: 2, // Finalized
        pub_key_share: "BD/epjiGun5PcXZxWKOYLytQPn0+yh2sXLFevagcm/muow==",
      };
      const decoded = decodeDKGRegistration(finalizedRaw);
      expect(decoded.pubKeyShare).toBeInstanceOf(Uint8Array);
      expect(decoded.pubKeyShare?.length).toBeGreaterThan(0);
      expect(decoded.status).toBe(2);
    });

    it("treats missing pub_key_share field as undefined (not empty bytes)", () => {
      const decoded = decodeDKGRegistration(verifiedRaw);
      expect(decoded.pubKeyShare).toBeUndefined();
    });
  });

  describe("decodeSubmission", () => {
    const raw: RawSubmission = {
      validator: "0xA5D284381bB6905C6954802F1fc22C84E7d15Df6",
      round: 6,
      pid: 1,
      encrypted_partial: "BD/epjiGun5PcXZxWKOY",
      ephemeral_pub_key: "BD/bQKBszsJwi6Ok5LGL",
      pub_share: "BD/epjiGun5PcXZxWKOYLytQPn0+yh2sXLFevagcm/muow==",
      // 32-byte big-endian encoding of uuid 42 (0x2a in last byte).
      label: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACo=",
      ciphertext: "QwAB",
    };

    it("lowercases validator address and decodes byte fields", () => {
      const decoded = decodeSubmission(raw);
      expect(decoded.validator).toBe(
        "0xa5d284381bb6905c6954802f1fc22c84e7d15df6",
      );
      expect(decoded.round).toBe(6);
      expect(decoded.pid).toBe(1);
      expect(decoded.encryptedPartial).toBeInstanceOf(Uint8Array);
      expect(decoded.ephemeralPubKey).toBeInstanceOf(Uint8Array);
      expect(decoded.pubShare).toBeInstanceOf(Uint8Array);
      expect(decoded.label).toBeInstanceOf(Uint8Array);
      expect(decoded.ciphertext).toBeInstanceOf(Uint8Array);
    });

    it("decodes label to 32-byte big-endian uuid (lower 4 bytes carry value)", () => {
      const decoded = decodeSubmission(raw);
      expect(decoded.label.length).toBe(32);
      expect(bytesToHex(decoded.label.slice(-4))).toBe("0000002a");
    });
  });

  describe("decodeSubmissionsByRound", () => {
    const raw: RawSubmissionsByRound = {
      round: 6,
      submissions: [
        {
          validator: "0xa5d284381bb6905c6954802f1fc22c84e7d15df6",
          round: 6,
          pid: 1,
          encrypted_partial: "BD/e",
          ephemeral_pub_key: "BD/b",
          pub_share: "BD/e",
          label: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACo=",
          ciphertext: "QwAB",
        },
      ],
      ciphertext: "QwAB",
      threshold: 3,
      threshold_met: false,
    };

    it("maps snake_case fields and decodes ciphertext", () => {
      const decoded = decodeSubmissionsByRound(raw);
      expect(decoded.round).toBe(6);
      expect(decoded.threshold).toBe(3);
      expect(decoded.thresholdMet).toBe(false);
      expect(decoded.ciphertext).toBeInstanceOf(Uint8Array);
      expect(decoded.submissions).toHaveLength(1);
      expect(decoded.submissions[0].pid).toBe(1);
    });

    it("treats null submissions array as empty", () => {
      const decoded = decodeSubmissionsByRound({
        ...raw,
        submissions: null as unknown as RawSubmission[],
      });
      expect(decoded.submissions).toEqual([]);
    });

    it("decodes empty submissions array", () => {
      const decoded = decodeSubmissionsByRound({ ...raw, submissions: [] });
      expect(decoded.submissions).toEqual([]);
    });

    it("propagates threshold_met=true correctly", () => {
      const decoded = decodeSubmissionsByRound({ ...raw, threshold_met: true });
      expect(decoded.thresholdMet).toBe(true);
    });
  });
});
