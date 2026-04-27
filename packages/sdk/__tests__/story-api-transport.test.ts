import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchJSON, joinPath } from "../src/story-api/transport.js";
import {
  StoryApiError,
  StoryApiNotFoundError,
} from "../src/story-api/errors.js";

const API_URL = "http://test:1317";
const URL = `${API_URL}/dkg/test`;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

describe("story-api/transport", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("joinPath", () => {
    it("joins base URL and path", () => {
      expect(joinPath("http://a:1", "/x")).toBe("http://a:1/x");
    });

    it("strips trailing slashes from base", () => {
      expect(joinPath("http://a:1/", "/x")).toBe("http://a:1/x");
      expect(joinPath("http://a:1//", "/x")).toBe("http://a:1/x");
    });
  });

  describe("happy path", () => {
    it("returns inner msg on 200 + envelope code 200", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, { code: 200, msg: { foo: "bar" }, error: "" }),
      );
      const result = await fetchJSON<{ foo: string }>(URL, { apiUrl: API_URL });
      expect(result).toEqual({ foo: "bar" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("sends Accept: application/json header", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, { code: 200, msg: {}, error: "" }),
      );
      await fetchJSON(URL, { apiUrl: API_URL });
      expect(fetchMock).toHaveBeenCalledWith(
        URL,
        expect.objectContaining({ headers: { Accept: "application/json" } }),
      );
    });
  });

  describe("404 handling", () => {
    it("throws StoryApiNotFoundError on plain text 404 (Go HTTP mux unregistered path)", async () => {
      fetchMock.mockResolvedValue(textResponse(404, "404 page not found"));
      await expect(fetchJSON(URL, { apiUrl: API_URL })).rejects.toBeInstanceOf(
        StoryApiNotFoundError,
      );
    });

    it("throws StoryApiNotFoundError on JSON envelope 404", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(404, { code: 404, msg: null, error: "not found" }),
      );
      await expect(fetchJSON(URL, { apiUrl: API_URL })).rejects.toBeInstanceOf(
        StoryApiNotFoundError,
      );
    });

    it("does not retry on 404", async () => {
      fetchMock.mockResolvedValue(textResponse(404, "404 page not found"));
      try {
        await fetchJSON(URL, { apiUrl: API_URL });
      } catch {
        /* expected */
      }
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("5xx handling", () => {
    it(
      "retries up to 3 times on 5xx then throws StoryApiError",
      async () => {
        // Use mockImplementation so each retry gets a fresh Response
        // (a single Response instance is "unusable" once its body is read).
        fetchMock.mockImplementation(async () =>
          textResponse(500, "internal error"),
        );
        await expect(fetchJSON(URL, { apiUrl: API_URL })).rejects.toBeInstanceOf(
          StoryApiError,
        );
        expect(fetchMock).toHaveBeenCalledTimes(3);
      },
      10_000,
    );

    it(
      "succeeds when 5xx is followed by 200",
      async () => {
        fetchMock
          .mockResolvedValueOnce(textResponse(503, "unavailable"))
          .mockResolvedValueOnce(
            jsonResponse(200, { code: 200, msg: { ok: true }, error: "" }),
          );
        const result = await fetchJSON<{ ok: boolean }>(URL, { apiUrl: API_URL });
        expect(result).toEqual({ ok: true });
        expect(fetchMock).toHaveBeenCalledTimes(2);
      },
      10_000,
    );
  });

  describe("4xx (non-404) handling", () => {
    it("throws StoryApiError without retrying on 400", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(400, { code: 400, msg: null, error: "bad request" }),
      );
      await expect(fetchJSON(URL, { apiUrl: API_URL })).rejects.toBeInstanceOf(
        StoryApiError,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("throws StoryApiError without retrying on 401", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(401, { code: 401, msg: null, error: "unauthorized" }),
      );
      await expect(fetchJSON(URL, { apiUrl: API_URL })).rejects.toBeInstanceOf(
        StoryApiError,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("envelope handling", () => {
    it("throws StoryApiError when envelope.code !== 200 (despite HTTP 200)", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          code: 500,
          msg: null,
          error: "server-side handler error",
        }),
      );
      const err = await fetchJSON(URL, { apiUrl: API_URL }).catch((e) => e);
      expect(err).toBeInstanceOf(StoryApiError);
      expect((err as Error).message).toContain("server-side handler error");
    });

    it("throws StoryApiError when body is non-JSON on HTTP 200", async () => {
      fetchMock.mockResolvedValue(textResponse(200, "garbled non-json"));
      await expect(fetchJSON(URL, { apiUrl: API_URL })).rejects.toBeInstanceOf(
        StoryApiError,
      );
    });

    it("throws StoryApiError when envelope.msg is null on HTTP 200", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, { code: 200, msg: null, error: "" }),
      );
      await expect(fetchJSON(URL, { apiUrl: API_URL })).rejects.toBeInstanceOf(
        StoryApiError,
      );
    });
  });

  describe("network errors", () => {
    it(
      "retries on fetch reject and throws after retries exhausted",
      async () => {
        fetchMock.mockRejectedValue(new Error("network down"));
        await expect(fetchJSON(URL, { apiUrl: API_URL })).rejects.toThrow(
          "network down",
        );
        expect(fetchMock).toHaveBeenCalledTimes(3);
      },
      10_000,
    );

    it(
      "succeeds when network recovers within retry budget",
      async () => {
        fetchMock
          .mockRejectedValueOnce(new Error("flaky"))
          .mockResolvedValueOnce(
            jsonResponse(200, { code: 200, msg: { ok: true }, error: "" }),
          );
        const result = await fetchJSON<{ ok: boolean }>(URL, { apiUrl: API_URL });
        expect(result).toEqual({ ok: true });
        expect(fetchMock).toHaveBeenCalledTimes(2);
      },
      10_000,
    );
  });

  describe("AbortSignal", () => {
    it("throws if signal is already aborted before fetch", async () => {
      const ac = new AbortController();
      ac.abort(new Error("user cancel"));
      await expect(
        fetchJSON(URL, { apiUrl: API_URL, signal: ac.signal }),
      ).rejects.toThrow("user cancel");
      expect(fetchMock).toHaveBeenCalledTimes(0);
    });

    it("forwards signal to fetch", async () => {
      const ac = new AbortController();
      fetchMock.mockResolvedValue(
        jsonResponse(200, { code: 200, msg: {}, error: "" }),
      );
      await fetchJSON(URL, { apiUrl: API_URL, signal: ac.signal });
      expect(fetchMock).toHaveBeenCalledWith(
        URL,
        expect.objectContaining({ signal: ac.signal }),
      );
    });
  });
});
