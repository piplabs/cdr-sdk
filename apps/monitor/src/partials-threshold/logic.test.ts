import { describe, it, expect } from "vitest";
import {
  buildSlackPayload,
  classifyExpired,
  isExpired,
  matchGroup,
  nextScanFrom,
  requestKey,
  type Outcome,
  type PartialGroup,
} from "./logic.js";
import type { PendingRequest } from "./state.js";

const req = (over: Partial<PendingRequest> = {}): PendingRequest => ({
  uuid: 1,
  requesterPubKeyHex: "0xab",
  ciphertextHex: "0xdead",
  block: 100,
  deadline: 300,
  round: 5,
  threshold: 3,
  ...over,
});

const grp = (over: Partial<PartialGroup> = {}): PartialGroup => ({
  round: 5,
  ciphertextHex: "0xdead",
  submitted: 3,
  threshold: 3,
  thresholdMet: true,
  ...over,
});

describe("isExpired", () => {
  it("is not expired exactly at the deadline (strict >)", () => {
    expect(isExpired(req({ deadline: 300 }), 300)).toBe(false);
  });
  it("is expired one block past the deadline", () => {
    expect(isExpired(req({ deadline: 300 }), 301)).toBe(true);
  });
});

describe("nextScanFrom", () => {
  it("scans one timeout window back on first run", () => {
    expect(nextScanFrom(null, 1000, 200)).toBe(800);
  });
  it("clamps to 0 when head is within the first window", () => {
    expect(nextScanFrom(null, 50, 200)).toBe(0);
  });
  it("resumes right after the last scanned block", () => {
    expect(nextScanFrom(500, 1000, 200)).toBe(501);
  });
});

describe("matchGroup", () => {
  it("matches by ciphertext and prefers the newest round", () => {
    const g = matchGroup(req(), [grp({ round: 4 }), grp({ round: 6 }), grp({ ciphertextHex: "0xbeef", round: 9 })]);
    expect(g?.round).toBe(6);
  });
  it("ignores zero-submission groups", () => {
    expect(matchGroup(req(), [grp({ submitted: 0 })])).toBeUndefined();
  });
  it("returns undefined when no ciphertext matches", () => {
    expect(matchGroup(req(), [grp({ ciphertextHex: "0xbeef" })])).toBeUndefined();
  });
  it("matches case-insensitively", () => {
    expect(matchGroup(req({ ciphertextHex: "0xDEAD" }), [grp({ ciphertextHex: "0xdead" })])).toBeDefined();
  });
});

describe("classifyExpired", () => {
  it("is met when thresholdMet and submitted >= threshold", () => {
    expect(classifyExpired(req(), [grp({ submitted: 3, threshold: 3, thresholdMet: true })]).kind).toBe("met");
  });
  it("is shortfall when below threshold", () => {
    expect(classifyExpired(req(), [grp({ submitted: 2, threshold: 3, thresholdMet: false })])).toMatchObject({
      kind: "shortfall",
      submitted: 2,
      threshold: 3,
    });
  });
  it("is shortfall (0 submitted) using the ingest-time threshold when no partials exist", () => {
    expect(classifyExpired(req({ threshold: 4 }), [])).toMatchObject({
      kind: "shortfall",
      submitted: 0,
      threshold: 4,
    });
  });
  it("is shortfall when thresholdMet is false even if submitted >= threshold", () => {
    expect(classifyExpired(req(), [grp({ submitted: 3, threshold: 3, thresholdMet: false })]).kind).toBe("shortfall");
  });
});

describe("requestKey", () => {
  it("combines uuid and lowercased ciphertext", () => {
    expect(requestKey(7, "0xDEAD")).toBe("7:0xdead");
  });
});

describe("buildSlackPayload", () => {
  const shortfall = (over: Partial<PendingRequest> = {}, submitted = 1, threshold = 3) =>
    ({ kind: "shortfall", req: req(over), submitted, threshold }) as Extract<Outcome, { kind: "shortfall" }>;

  it("batches every shortfall into a single message", () => {
    const payload = buildSlackPayload(
      [shortfall({ uuid: 1, block: 100 }, 1, 3), shortfall({ uuid: 2, block: 120 }, 0, 3)],
      { network: "aeneid", head: 500, runUrl: "http://x" },
    ) as { text: string; blocks: Array<{ type: string; text?: { text: string } }> };
    expect(payload.text).toContain("2 requests");
    expect(payload.blocks[1].text?.text).toContain("uuid `1`");
    expect(payload.blocks[1].text?.text).toContain("uuid `2`");
    expect(payload.blocks[2].type).toBe("actions");
  });

  it("uses singular wording and omits the run button when no runUrl", () => {
    const payload = buildSlackPayload([shortfall()], { network: "aeneid", head: 500 }) as {
      text: string;
      blocks: unknown[];
    };
    expect(payload.text).toContain("1 request ");
    expect(payload.blocks).toHaveLength(2);
  });
});
