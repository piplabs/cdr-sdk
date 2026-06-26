import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMPTY_STATE, loadState, saveState, type ReadRequestsState } from "./state.js";

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cdr-monitor-"));
  path = join(dir, "read_requests.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("loadState", () => {
  it("returns empty state when the file is absent (first run)", async () => {
    expect(await loadState(path)).toEqual(EMPTY_STATE);
  });

  it("returns empty state when the file is malformed JSON", async () => {
    await writeFile(path, "not-json", "utf8");
    expect(await loadState(path)).toEqual(EMPTY_STATE);
  });

  it("returns empty state when the shape is wrong (missing requests array)", async () => {
    await writeFile(path, JSON.stringify({ lastScannedBlock: 5 }), "utf8");
    expect(await loadState(path)).toEqual(EMPTY_STATE);
  });

  it("coerces a non-numeric lastScannedBlock to null", async () => {
    await writeFile(path, JSON.stringify({ lastScannedBlock: "oops", requests: [] }), "utf8");
    expect(await loadState(path)).toEqual({ lastScannedBlock: null, requests: [] });
  });
});

describe("saveState / loadState round-trip", () => {
  it("persists and reloads state unchanged", async () => {
    const state: ReadRequestsState = {
      lastScannedBlock: 1234,
      requests: [
        {
          uuid: 7,
          requesterPubKeyHex: "0xabcd",
          ciphertextHex: "0xdead",
          block: 1000,
          deadline: 1200,
          round: 5,
          threshold: 3,
        },
      ],
    };
    await saveState(path, state);
    expect(await loadState(path)).toEqual(state);
  });
});
