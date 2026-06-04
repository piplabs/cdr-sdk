import { createPublicClient, http, bytesToHex, type Address, type PublicClient } from "viem";
import {
  cdrAbi,
  contractAddresses,
  queryCDRPartials,
  queryLatestActiveDKGNetwork,
  StoryApiError,
  StoryApiNotFoundError,
} from "@piplabs/cdr-sdk";
import { loadState, saveState, type PendingRequest, type ReadRequestsState } from "./state.js";
import {
  buildSlackPayload,
  classifyExpired,
  isExpired,
  nextScanFrom,
  requestKey,
  type Outcome,
  type PartialGroup,
} from "./logic.js";

// Network label as used across the cdr-sdk workflows (aeneid/mainnet). Selects
// the default RPC when CDR_RPC_URL is unset and labels the Slack message.
const DEFAULT_RPC_URLS: Record<string, string> = {
  aeneid: "https://aeneid.storyrpc.io",
  mainnet: "https://mainnet.storyrpc.io",
};

// CDR is a Story predeploy at the same address on every network.
const CDR_ADDRESS_BY_NETWORK: Record<string, Address> = {
  aeneid: contractAddresses.mainnet.cdr,
  mainnet: contractAddresses.mainnet.cdr,
};

/** Chunk getLogs to stay under RPC block-range limits (matters only after long downtime). */
const MAX_LOG_RANGE = 1000;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

type VaultReadArgs = { uuid: number; ciphertext: `0x${string}`; requesterPubKey: `0x${string}` };

// "No partials for this request" is the most important shortfall case, but the
// Story-API reports it as HTTP 500 with a NotFound message (not a 404), so the
// SDK surfaces it as a StoryApiError rather than [] / StoryApiNotFoundError.
// Treat it as zero partials so it alerts instead of being mistaken for a
// transient REST error and retried forever.
function isPartialsNotFound(err: unknown): boolean {
  if (err instanceof StoryApiNotFoundError) return true;
  return err instanceof StoryApiError && /not found/i.test(err.message);
}

async function getVaultReadLogs(
  client: PublicClient,
  address: Address,
  fromBlock: number,
  toBlock: number,
): Promise<Array<{ args: VaultReadArgs; blockNumber: bigint }>> {
  const out: Array<{ args: VaultReadArgs; blockNumber: bigint }> = [];
  for (let start = fromBlock; start <= toBlock; start += MAX_LOG_RANGE) {
    const end = Math.min(start + MAX_LOG_RANGE - 1, toBlock);
    const logs = await client.getContractEvents({
      address,
      abi: cdrAbi,
      eventName: "VaultRead",
      fromBlock: BigInt(start),
      toBlock: BigInt(end),
    });
    for (const log of logs) {
      out.push({ args: log.args as VaultReadArgs, blockNumber: log.blockNumber });
    }
  }
  return out;
}

async function main(): Promise<void> {
  const networkLabel = process.env.CDR_NETWORK ?? "aeneid";
  // `||` (not `??`) so an unset/empty CDR_RPC_URL secret falls back to the default.
  const rpcUrl = process.env.CDR_RPC_URL || DEFAULT_RPC_URLS[networkLabel] || DEFAULT_RPC_URLS.aeneid;
  const apiUrl = requireEnv("CDR_API_URL");
  const webhook = process.env.CDR_SLACK_WEBHOOK_URL;
  const statePath = process.env.READ_REQUESTS_PATH ?? "./read_requests.json";
  const timeout = Number(process.env.DECRYPT_TIMEOUT_BLOCKS ?? "200");
  const runUrl = process.env.RUN_URL;

  const cdr = CDR_ADDRESS_BY_NETWORK[networkLabel] ?? contractAddresses.mainnet.cdr;
  const client = createPublicClient({ transport: http(rpcUrl) }) as PublicClient;

  const head = Number(await client.getBlockNumber());
  const state = await loadState(statePath);

  // ── Step 1: sweep requests whose deadline has passed ──────────────────────
  const expired = state.requests.filter((r) => isExpired(r, head));
  const remaining = state.requests.filter((r) => !isExpired(r, head));

  const shortfalls: Array<Extract<Outcome, { kind: "shortfall" }>> = [];
  for (const req of expired) {
    let groups: PartialGroup[];
    try {
      const raw = await queryCDRPartials({
        apiUrl,
        uuid: req.uuid,
        requesterPubKeyHex: req.requesterPubKeyHex,
      });
      groups = raw.map((g) => ({
        round: g.round,
        ciphertextHex: bytesToHex(g.ciphertext),
        submitted: g.submissions.length,
        threshold: g.threshold,
        thresholdMet: g.thresholdMet,
      }));
    } catch (err) {
      if (isPartialsNotFound(err)) {
        // No partials were ever submitted → definitively below threshold.
        groups = [];
      } else {
        // Genuine transient error: keep the request so it is retried next run.
        remaining.push(req);
        console.error(`queryCDRPartials failed for uuid=${req.uuid}; retry next run`, err);
        continue;
      }
    }
    const outcome = classifyExpired(req, groups);
    if (outcome.kind === "shortfall") shortfalls.push(outcome);
    // met → silently dropped (not re-added to remaining)
  }

  // ── Step 2: ingest new VaultRead requests ─────────────────────────────────
  const fromBlock = nextScanFrom(state.lastScannedBlock, head, timeout);
  const seen = new Set(remaining.map((r) => requestKey(r.uuid, r.ciphertextHex)));
  if (fromBlock <= head) {
    const logs = await getVaultReadLogs(client, cdr, fromBlock, head);
    let active: { round: number; threshold: number } | null = null;
    for (const log of logs) {
      const ciphertextHex = log.args.ciphertext.toLowerCase() as `0x${string}`;
      const key = requestKey(log.args.uuid, ciphertextHex);
      if (seen.has(key)) continue;
      // Capture the active round/threshold once, only if there is anything to ingest.
      if (active === null) {
        const net = await queryLatestActiveDKGNetwork({ apiUrl });
        active = { round: net.round, threshold: net.threshold };
      }
      const block = Number(log.blockNumber);
      const req: PendingRequest = {
        uuid: log.args.uuid,
        requesterPubKeyHex: log.args.requesterPubKey.toLowerCase(),
        ciphertextHex,
        block,
        deadline: block + timeout,
        round: active.round,
        threshold: active.threshold,
      };
      remaining.push(req);
      seen.add(key);
    }
  }

  const newState: ReadRequestsState = { lastScannedBlock: head, requests: remaining };

  // ── Step 3: alert (batched) then persist ──────────────────────────────────
  // Persist only after a successful Slack post so a post failure re-detects and
  // re-alerts next run instead of silently dropping the shortfalls.
  if (shortfalls.length > 0) {
    if (!webhook) {
      throw new Error(
        `${shortfalls.length} threshold shortfall(s) detected but CDR_SLACK_WEBHOOK_URL is not set`,
      );
    }
    const payload = buildSlackPayload(shortfalls, { network: networkLabel, head, runUrl });
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(`Slack POST failed: ${res.status} ${await res.text()}`);
    }
  }

  await saveState(statePath, newState);

  console.log(
    `head=${head} scanned_from=${fromBlock} expired=${expired.length} ` +
      `shortfalls=${shortfalls.length} pending=${remaining.length}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
