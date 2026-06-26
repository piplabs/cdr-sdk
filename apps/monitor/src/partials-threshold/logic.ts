import type { PendingRequest } from "./state.js";

/** A `/dkg/cdr_partials` group reduced to the scalars the monitor needs. */
export interface PartialGroup {
  round: number;
  ciphertextHex: string;
  submitted: number;
  threshold: number;
  thresholdMet: boolean;
}

export type Outcome =
  | { kind: "met"; req: PendingRequest; submitted: number; threshold: number }
  | { kind: "shortfall"; req: PendingRequest; submitted: number; threshold: number };

/** Stable identity for a decrypt request: (uuid, ciphertext). */
export function requestKey(uuid: number, ciphertextHex: string): string {
  return `${uuid}:${ciphertextHex.toLowerCase()}`;
}

/**
 * A request has passed its on-chain decrypt timeout once head is strictly past
 * its deadline. Strict `>` mirrors the keeper's
 * `currentHeight - reqHeight > DefaultDecryptTimeout`, so a partial accepted
 * exactly at block+timeout is not falsely flagged.
 */
export function isExpired(req: PendingRequest, head: number): boolean {
  return head > req.deadline;
}

/**
 * First run scans one timeout window back (only requests that could still be
 * open); later runs resume right after the last scanned block. No reorg buffer:
 * CometBFT finalizes on commit, so head is final.
 */
export function nextScanFrom(lastScannedBlock: number | null, head: number, timeout: number): number {
  if (lastScannedBlock === null) return Math.max(0, head - timeout);
  return lastScannedBlock + 1;
}

/** Pick the group matching this request's ciphertext, preferring the newest round. */
export function matchGroup(req: PendingRequest, groups: PartialGroup[]): PartialGroup | undefined {
  const target = req.ciphertextHex.toLowerCase();
  return groups
    .filter((g) => g.submitted > 0 && g.ciphertextHex.toLowerCase() === target)
    .sort((a, b) => b.round - a.round)[0];
}

/**
 * Classify an expired request. `met` when the keeper reports the threshold
 * reached; otherwise `shortfall`. For the zero-partial case (no matching group)
 * the threshold recorded at ingest is used.
 */
export function classifyExpired(req: PendingRequest, groups: PartialGroup[]): Outcome {
  const g = matchGroup(req, groups);
  if (g && g.thresholdMet && g.submitted >= g.threshold) {
    return { kind: "met", req, submitted: g.submitted, threshold: g.threshold };
  }
  return {
    kind: "shortfall",
    req,
    submitted: g?.submitted ?? 0,
    threshold: g?.threshold ?? req.threshold,
  };
}

export interface SlackContext {
  network: string;
  head: number;
  runUrl?: string;
}

/** Build a single batched Slack message for all shortfalls in this run. */
export function buildSlackPayload(
  shortfalls: Array<Extract<Outcome, { kind: "shortfall" }>>,
  ctx: SlackContext,
): unknown {
  const n = shortfalls.length;
  const headline = `🚨 CDR threshold shortfall (${ctx.network}) — ${n} request${n === 1 ? "" : "s"} expired below threshold`;
  // Slack mrkdwn bold is single `*…*`.
  const lines = shortfalls
    .map(
      (s) =>
        `• round *${s.req.round}* · uuid \`${s.req.uuid}\` · *${s.submitted}/${s.threshold}* partials · req block ${s.req.block}`,
    )
    .join("\n");

  const blocks: unknown[] = [
    { type: "section", text: { type: "mrkdwn", text: `*${headline}*` } },
    { type: "section", text: { type: "mrkdwn", text: lines } },
  ];
  if (ctx.runUrl) {
    blocks.push({
      type: "actions",
      elements: [
        { type: "button", text: { type: "plain_text", text: "View workflow run" }, url: ctx.runUrl },
      ],
    });
  }
  return { text: headline, blocks };
}
