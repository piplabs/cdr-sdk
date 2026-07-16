#!/usr/bin/env node
/**
 * Post-release Aeneid end-to-end smoke: uploadCDR + accessCDR against a
 * live Aeneid validator set, using a fresh subwallet funded from the CI
 * funder. The subwallet pattern avoids nonce collisions with concurrent
 * Aeneid-targeted runs (e.g. the existing `ephemeral-100w-fresh-aeneid`
 * suite) that share the same funder key.
 *
 * Runs against the actually-published @piplabs/cdr-sdk tarball — the
 * workflow installs the package into a `mktemp -d` outside the workspace
 * and copies this file in alongside it.
 *
 * Env (all required):
 *   CDR_API_URL                    Story-API REST URL on Aeneid
 *   CDR_RPC_URL                    Aeneid public EVM RPC
 *   CDR_AENEID_TEST_PRIVATE_KEY    Funder key — same secret used by CI.
 *                                  Used ONLY to fund the subwallet; never
 *                                  signs uploadCDR / accessCDR txs.
 *
 * Local invocation:
 *   set -a && source .env.local && set +a
 *   node .github/scripts/post-release-aeneid-e2e.mjs
 *
 * Exit codes: 0 on success, 1 on e2e failure, 2 on missing env.
 *
 * Side effect: writes `status.json` to $STATUS_JSON_PATH (default
 * `./status.json`) on every code path — the workflow's summary step
 * consumes it. Even on failure status.json is written, so a step
 * summary can render diagnostics without needing to scrape stdout.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { CDRClient, initWasm } from "@piplabs/cdr-sdk";
import { writeFileSync } from "node:fs";

const API_URL = process.env.CDR_API_URL;
const RPC_URL = process.env.CDR_RPC_URL;
const RAW_FUNDER_KEY = process.env.CDR_AENEID_TEST_PRIVATE_KEY;
const STATUS_PATH = process.env.STATUS_JSON_PATH || "status.json";

if (!API_URL || !RPC_URL || !RAW_FUNDER_KEY) {
  console.error(
    `::error::missing required env — CDR_API_URL=${!!API_URL} CDR_RPC_URL=${!!RPC_URL} CDR_AENEID_TEST_PRIVATE_KEY=${!!RAW_FUNDER_KEY}`,
  );
  process.exit(2);
}

// Normalize the funder key: accept either `0x`-prefixed or bare 64-char
// hex. Some operators store keys with the prefix, some without — both
// represent the same 32 bytes. viem's privateKeyToAccount requires the
// prefix, so we add it if missing rather than reject one valid form.
const FUNDER_KEY = RAW_FUNDER_KEY.startsWith("0x")
  ? RAW_FUNDER_KEY
  : `0x${RAW_FUNDER_KEY}`;

// 0.1 IP / 0.001 IP — match the precedent in
// `ephemeral-100w-fresh-aeneid.test.ts` and `_ephemeral-wallets.ts`
// (same workload shape, same gas reserve).
const FUND_AMOUNT_WEI = 100_000_000_000_000_000n; // 0.1 IP
const GAS_RESERVE_WEI = 1_000_000_000_000_000n; //   0.001 IP

// Mirrors `resilientHttp` from `packages/sdk/__integration__/_rpc-resilience.ts`
// — viem's default ~1s retry budget is too tight for Aeneid's public RPC.
// The helper isn't in the published tarball so we inline the one line here.
function resilientHttp() {
  return http(RPC_URL, { retryCount: 5, retryDelay: 500 });
}

const status = {
  subwalletAddress: null,
  funder: { address: null, fundTx: null, fundedWei: null },
  deploy: { tx: null, openCondition: null },
  upload: { txAllocate: null, txWrite: null, uuid: null, latencyMs: null },
  access: { txRead: null, latencyMs: null, recovered: false },
  refund: { tx: null, refundedWei: null, error: null },
  totalWallClockMs: null,
  outcome: "pending",
  error: null,
};

function writeStatus() {
  try {
    writeFileSync(STATUS_PATH, JSON.stringify(status, null, 2));
  } catch (err) {
    console.error(`failed to write ${STATUS_PATH}: ${err.message}`);
  }
}

const tStart = Date.now();
let subKey = null;

try {
  await initWasm();

  const funderAccount = privateKeyToAccount(FUNDER_KEY);
  const funderPublic = createPublicClient({ transport: resilientHttp() });
  const funderWallet = createWalletClient({
    account: funderAccount,
    transport: resilientHttp(),
  });
  status.funder.address = funderAccount.address;
  console.log(`funder address: ${funderAccount.address}`);

  // Fail fast with a useful message if the funder is empty — otherwise
  // the operator chases down a generic "insufficient funds" deep in viem.
  const funderBalance = await funderPublic.getBalance({
    address: funderAccount.address,
  });
  console.log(`funder balance: ${formatEther(funderBalance)} IP`);
  if (funderBalance < FUND_AMOUNT_WEI + GAS_RESERVE_WEI) {
    throw new Error(
      `funder ${funderAccount.address} has insufficient balance: ${formatEther(funderBalance)} IP (need ≥${formatEther(FUND_AMOUNT_WEI + GAS_RESERVE_WEI)})`,
    );
  }

  subKey = generatePrivateKey();
  const subAccount = privateKeyToAccount(subKey);
  status.subwalletAddress = subAccount.address;
  console.log(`subwallet:      ${subAccount.address}`);

  const fundTx = await funderWallet.sendTransaction({
    to: subAccount.address,
    value: FUND_AMOUNT_WEI,
    chain: funderWallet.chain ?? null,
    account: funderWallet.account ?? null,
  });
  await funderPublic.waitForTransactionReceipt({ hash: fundTx });
  status.funder.fundTx = fundTx;
  status.funder.fundedWei = FUND_AMOUNT_WEI.toString();
  console.log(`fund tx:        ${fundTx}`);

  const subPublic = createPublicClient({ transport: resilientHttp() });
  const subWallet = createWalletClient({
    account: subAccount,
    transport: resilientHttp(),
  });
  const sdk = new CDRClient({
    network: "testnet",
    publicClient: subPublic,
    walletClient: subWallet,
    apiUrl: API_URL,
  });
  const openConditionBytecode =
    "0x602a600c600039602a6000f360003560e01c80635645dbbf14601f5780638db3eb1714601f5760006000fd5b600160005260206000f3";
  const deployTx = await subWallet.sendTransaction({
    data: openConditionBytecode,
    chain: subWallet.chain ?? null,
    account: subWallet.account ?? null,
  });
  const deployReceipt = await subPublic.waitForTransactionReceipt({
    hash: deployTx,
  });
  if (!deployReceipt.contractAddress) {
    throw new Error("open-condition deploy: receipt missing contractAddress");
  }
  status.deploy.tx = deployTx;
  status.deploy.openCondition = deployReceipt.contractAddress;
  console.log(`open-condition: ${deployReceipt.contractAddress}`);

  const dataKey = crypto.getRandomValues(new Uint8Array(32));
  const tUpload = Date.now();
  const upload = await sdk.uploader.uploadCDR({
    dataKey,
    updatable: false,
    writeConditionAddr: deployReceipt.contractAddress,
    readConditionAddr: deployReceipt.contractAddress,
    writeConditionData: "0x",
    readConditionData: "0x",
    accessAuxData: "0x",
  });
  status.upload.latencyMs = Date.now() - tUpload;
  status.upload.uuid = upload.uuid;
  status.upload.txAllocate = upload.txHashes.allocate;
  status.upload.txWrite = upload.txHashes.write;
  console.log(
    `upload:         uuid=${upload.uuid} allocate=${upload.txHashes.allocate} write=${upload.txHashes.write} (${status.upload.latencyMs}ms)`,
  );

  const tAccess = Date.now();
  const access = await sdk.consumer.accessCDR({
    uuid: upload.uuid,
    accessAuxData: "0x",
    timeoutMs: 180_000,
  });
  status.access.latencyMs = Date.now() - tAccess;
  status.access.txRead = access.txHash;

  const recovered = access.dataKey;
  const matches =
    recovered.length === dataKey.length &&
    recovered.every((b, i) => b === dataKey[i]);
  if (!matches) {
    const expHex = Buffer.from(dataKey).toString("hex");
    const gotHex = Buffer.from(recovered).toString("hex");
    throw new Error(
      `dataKey mismatch — expected 0x${expHex}, recovered 0x${gotHex}`,
    );
  }
  status.access.recovered = true;
  console.log(
    `access:         read=${access.txHash} recovered=ok (${status.access.latencyMs}ms)`,
  );
  status.outcome = "success";
} catch (err) {
  status.outcome = "failure";
  status.error = err && err.message ? err.message : String(err);
  console.error(`::error::${status.error}`);
} finally {
  // Refund runs on both success and failure paths so we don't bleed test
  // IP into a dead ephemeral wallet. Inner try/catch ensures a refund
  // failure doesn't override the main outcome.
  if (subKey && status.funder.address) {
    try {
      const subAccount = privateKeyToAccount(subKey);
      const subPublic = createPublicClient({ transport: resilientHttp() });
      const subWallet = createWalletClient({
        account: subAccount,
        transport: resilientHttp(),
      });
      const balance = await subPublic.getBalance({
        address: subAccount.address,
      });
      // Compute the actual gas cost for the sweep tx; the static 0.001 IP
      // reserve only covers up to ~47 gwei (1e15 / 21_000). Under Aeneid
      // congestion above that breakpoint the sweep would fail and the
      // funder would silently bleed the subwallet. 2x buffer absorbs
      // base-fee fluctuation between quote and submit.
      const gasPrice = await subPublic.getGasPrice();
      const dynamicReserve = gasPrice * 21_000n * 2n;
      const reserve =
        dynamicReserve > GAS_RESERVE_WEI ? dynamicReserve : GAS_RESERVE_WEI;
      if (balance > reserve) {
        const sweepAmount = balance - reserve;
        const refundTx = await subWallet.sendTransaction({
          to: status.funder.address,
          value: sweepAmount,
          gas: 21_000n,
          chain: subWallet.chain ?? null,
          account: subWallet.account ?? null,
        });
        await subPublic.waitForTransactionReceipt({ hash: refundTx });
        status.refund.tx = refundTx;
        status.refund.refundedWei = sweepAmount.toString();
        console.log(
          `refund:         tx=${refundTx} amount=${formatEther(sweepAmount)} IP`,
        );
      } else {
        console.log(
          `refund:         skipped (balance ${formatEther(balance)} IP ≤ reserve ${formatEther(reserve)} IP)`,
        );
      }
    } catch (err) {
      status.refund.error = err && err.message ? err.message : String(err);
      console.error(`refund failed: ${status.refund.error}`);
    }
  }
  status.totalWallClockMs = Date.now() - tStart;
  writeStatus();
}

process.exit(status.outcome === "success" ? 0 : 1);
