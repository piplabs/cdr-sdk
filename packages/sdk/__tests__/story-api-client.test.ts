import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  queryLatestActiveDKGNetwork,
  queryDKGNetwork,
  queryGlobalPubKey,
  queryAllRegistrations,
  queryVerifiedRegistrations,
  queryCDRPartials,
} from "../src/story-api/client.js";
import { StoryApiNotFoundError } from "../src/story-api/errors.js";

const API_URL = "http://test:1317";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

const RAW_DKG_NETWORK = {
  round: 6,
  start_block_height: "1331",
  start_block_hash: "Lmkutr5aA5HeGloLDbs4HU0+HjpJqgTCRCNzuU63CY0=",
  active_val_set: ["0xa5d284381bb6905c6954802f1fc22c84e7d15df6"],
  total: 3,
  threshold: 2,
  stage: 4,
  is_resharing: true,
  global_public_key: "g8P8NKJWH/7pqNQZYpuDMGYQ1PMdOd5j/uOLaxBHfTc=",
  public_coeffs: ["g8P8NKJWH/7pqNQZYpuDMGYQ1PMdOd5j/uOLaxBHfTc="],
};

const RAW_REGISTRATION = {
  round: 5,
  validator_addr: "0xa5d284381bb6905c6954802f1fc22c84e7d15df6",
  index: 1,
  dkg_pub_key: "mTL7rsdEZSON66bC97qrtAq4in0hmAZzIJRPTpoqHU4=",
  comm_pub_key:
    "YTg83sfKrkSVfFYwYhXGZNzKWIH++4lPuzVA0wdNxsXqOPB8wKMK6kP+38xV0DvWaUGRqBUYqW2P/iJUmoFGgQ==",
  enclave_report: "AwACAAAAAAALABAAk5pyMw==",
  status: 2,
  code_commitment: "Kchx",
  enclave_type: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE=",
};

describe("story-api/client", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("queryLatestActiveDKGNetwork", () => {
    it("calls /dkg/latest_active and decodes the response", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          code: 200,
          msg: { network: RAW_DKG_NETWORK },
          error: "",
        }),
      );
      const result = await queryLatestActiveDKGNetwork({ apiUrl: API_URL });
      expect(fetchMock).toHaveBeenCalledWith(
        `${API_URL}/dkg/latest_active`,
        expect.any(Object),
      );
      expect(result.round).toBe(6);
      expect(result.globalPublicKey).toBeInstanceOf(Uint8Array);
      expect(result.globalPublicKey.length).toBe(32);
    });
  });

  describe("queryDKGNetwork", () => {
    it("includes round in query string", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          code: 200,
          msg: { network: RAW_DKG_NETWORK },
          error: "",
        }),
      );
      await queryDKGNetwork({ apiUrl: API_URL, round: 42 });
      expect(fetchMock).toHaveBeenCalledWith(
        `${API_URL}/dkg/dkg_network?round=42`,
        expect.any(Object),
      );
    });
  });

  describe("queryGlobalPubKey", () => {
    it("decodes hex public_key into 32-byte Uint8Array", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          code: 200,
          msg: {
            public_key:
              "83c3fc34a2561ffee9a8d419629b83306610d4f31d39de63fee38b6b10477d37",
          },
          error: "",
        }),
      );
      const result = await queryGlobalPubKey({ apiUrl: API_URL });
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(32);
    });

    it("propagates StoryApiNotFoundError on 404 (does not swallow)", async () => {
      fetchMock.mockResolvedValue(textResponse(404, "404 page not found"));
      await expect(queryGlobalPubKey({ apiUrl: API_URL })).rejects.toBeInstanceOf(
        StoryApiNotFoundError,
      );
    });
  });

  describe("queryAllRegistrations", () => {
    it("calls /dkg/registrations?round=N and decodes the array", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          code: 200,
          msg: { registrations: [RAW_REGISTRATION] },
          error: "",
        }),
      );
      const result = await queryAllRegistrations({ apiUrl: API_URL, round: 5 });
      expect(fetchMock).toHaveBeenCalledWith(
        `${API_URL}/dkg/registrations?round=5`,
        expect.any(Object),
      );
      expect(result).toHaveLength(1);
      expect(result[0].validatorAddr).toBe(
        "0xa5d284381bb6905c6954802f1fc22c84e7d15df6",
      );
      expect(result[0].commPubKey).toBeInstanceOf(Uint8Array);
    });

    it("returns [] on 404 (StoryApiNotFoundError swallowed)", async () => {
      fetchMock.mockResolvedValue(textResponse(404, "404 page not found"));
      const result = await queryAllRegistrations({
        apiUrl: API_URL,
        round: 999,
      });
      expect(result).toEqual([]);
    });

    it("returns [] when registrations field is null", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          code: 200,
          msg: { registrations: null },
          error: "",
        }),
      );
      const result = await queryAllRegistrations({ apiUrl: API_URL, round: 5 });
      expect(result).toEqual([]);
    });
  });

  describe("queryVerifiedRegistrations", () => {
    it("calls /dkg/registrations/verified?round=N", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          code: 200,
          msg: { registrations: [] },
          error: "",
        }),
      );
      await queryVerifiedRegistrations({ apiUrl: API_URL, round: 7 });
      expect(fetchMock).toHaveBeenCalledWith(
        `${API_URL}/dkg/registrations/verified?round=7`,
        expect.any(Object),
      );
    });

    it("returns [] on 404", async () => {
      fetchMock.mockResolvedValue(textResponse(404, "404 page not found"));
      const result = await queryVerifiedRegistrations({
        apiUrl: API_URL,
        round: 999,
      });
      expect(result).toEqual([]);
    });
  });

  describe("queryCDRPartials", () => {
    it("calls /dkg/cdr_partials with uuid and requesterPubKeyHex (no prefix)", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, { code: 200, msg: { submissions: [] }, error: "" }),
      );
      await queryCDRPartials({
        apiUrl: API_URL,
        uuid: 42,
        requesterPubKeyHex: "abcd1234",
      });
      expect(fetchMock).toHaveBeenCalledWith(
        `${API_URL}/dkg/cdr_partials?uuid=42&requester_pub_key_hex=abcd1234`,
        expect.any(Object),
      );
    });

    it("strips 0x prefix from requesterPubKeyHex", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, { code: 200, msg: { submissions: [] }, error: "" }),
      );
      await queryCDRPartials({
        apiUrl: API_URL,
        uuid: 42,
        requesterPubKeyHex: "0xABCD1234",
      });
      expect(fetchMock).toHaveBeenCalledWith(
        `${API_URL}/dkg/cdr_partials?uuid=42&requester_pub_key_hex=ABCD1234`,
        expect.any(Object),
      );
    });

    it("strips 0X prefix from requesterPubKeyHex", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, { code: 200, msg: { submissions: [] }, error: "" }),
      );
      await queryCDRPartials({
        apiUrl: API_URL,
        uuid: 42,
        requesterPubKeyHex: "0XABCD",
      });
      expect(fetchMock).toHaveBeenCalledWith(
        `${API_URL}/dkg/cdr_partials?uuid=42&requester_pub_key_hex=ABCD`,
        expect.any(Object),
      );
    });

    it("returns [] on 404", async () => {
      fetchMock.mockResolvedValue(textResponse(404, "404 page not found"));
      const result = await queryCDRPartials({
        apiUrl: API_URL,
        uuid: 42,
        requesterPubKeyHex: "abcd",
      });
      expect(result).toEqual([]);
    });

    it("decodes submissions array on 200", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          code: 200,
          msg: {
            submissions: [
              {
                round: 6,
                submissions: [],
                ciphertext: "QwAB",
                threshold: 3,
                threshold_met: false,
              },
            ],
          },
          error: "",
        }),
      );
      const result = await queryCDRPartials({
        apiUrl: API_URL,
        uuid: 42,
        requesterPubKeyHex: "abcd",
      });
      expect(result).toHaveLength(1);
      expect(result[0].round).toBe(6);
      expect(result[0].thresholdMet).toBe(false);
      expect(result[0].ciphertext).toBeInstanceOf(Uint8Array);
    });
  });
});
