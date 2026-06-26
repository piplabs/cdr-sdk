/**
 * DX (developer-experience) improvements — each test maps 1:1 to an
 * SDK feature issue. Migrated from story-cdr-e2e/cdr-sdk-tests/src/
 * dx-improvements.test.ts; the setup.ts shim was dropped in favor of
 * inline CDRClient construction.
 *
 *   DX-01 (#11)  conditions.{open,tokenGate,ownerOnly,merkle,custom}
 *   DX-02 (#12)  accessCDR with just {uuid, accessAuxData}
 *   DX-03 (#13)  LicenseReadCondition (Aeneid-only; skipped on other chains)
 *   DX-04 (#16)  Method aliases: createVault / readVault / *FileVault
 */

import { beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  type PublicClient,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  parseEther,
  toHex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { CDRClient, conditions, initWasm } from "../src/index.js";
import { OPEN_CONDITION_BYTECODE } from "./_helpers.js";

const API_URL = process.env.CDR_API_URL;
const RPC_URL = process.env.CDR_RPC_URL;
const PRIVATE_KEY = process.env.CDR_TEST_PRIVATE_KEY as
  | `0x${string}`
  | undefined;

if (!API_URL) throw new Error("CDR_API_URL is not set");
if (!RPC_URL) throw new Error("CDR_RPC_URL is not set");
if (!PRIVATE_KEY) throw new Error("CDR_TEST_PRIVATE_KEY is not set");

function makeCDRClient(): {
  client: CDRClient;
  publicClient: PublicClient;
  walletClient: WalletClient;
} {
  const account = privateKeyToAccount(PRIVATE_KEY!);
  const publicClient = createPublicClient({
    transport: http(RPC_URL),
  }) as unknown as PublicClient;
  const walletClient = createWalletClient({
    account,
    transport: http(RPC_URL),
  }) as unknown as WalletClient;
  const client = new CDRClient({
    network: "testnet",
    publicClient,
    walletClient,
    apiUrl: API_URL!,
  });
  return { client, publicClient, walletClient };
}

async function deployOpenCondition(
  publicClient: PublicClient,
  walletClient: WalletClient,
): Promise<`0x${string}`> {
  const tx = await walletClient.sendTransaction({
    chain: walletClient.chain ?? null,
    account: walletClient.account ?? null,
    data: OPEN_CONDITION_BYTECODE,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
  if (!receipt.contractAddress) {
    throw new Error("Open-condition deploy: receipt missing contractAddress");
  }
  return receipt.contractAddress;
}

describe(`DX improvement tests (live: ${API_URL})`, () => {
  beforeAll(async () => {
    await initWasm();
  });

  it("DX-01: conditions helpers produce ConditionConfig shapes for each gating type (Issue #11)", () => {
    const condAddr =
      "0x0000000000000000000000000000000000000001" as `0x${string}`;
    const tokenAddr =
      "0x0000000000000000000000000000000000000002" as `0x${string}`;
    const ownerAddr =
      "0x0000000000000000000000000000000000000003" as `0x${string}`;
    const merkleRoot =
      "0x0000000000000000000000000000000000000000000000000000000000000abc" as `0x${string}`;

    const op = conditions.open({ address: condAddr });
    expect(op.address).toBe(condAddr);
    expect(op.conditionData).toBe("0x");

    const tg = conditions.tokenGate({
      address: condAddr,
      token: tokenAddr,
      minBalance: 100n,
    });
    expect(tg.address).toBe(condAddr);
    expect(tg.conditionData).toMatch(/^0x/);
    expect(tg.conditionData.length).toBeGreaterThan(2);

    const oo = conditions.ownerOnly({ address: condAddr, owner: ownerAddr });
    expect(oo.address).toBe(condAddr);
    expect(oo.conditionData).toMatch(/^0x/);
    expect(oo.conditionData.length).toBeGreaterThan(2);

    const mk = conditions.merkle({ address: condAddr, root: merkleRoot });
    expect(mk.address).toBe(condAddr);
    expect(mk.conditionData).toMatch(/^0x/);
    expect(mk.conditionData.length).toBeGreaterThan(2);

    const custom = "0xdeadbeef" as `0x${string}`;
    const cu = conditions.custom({ address: condAddr, conditionData: custom });
    expect(cu.address).toBe(condAddr);
    expect(cu.conditionData).toBe(custom);
  });

  it("DX-02: accessCDR with only uuid + accessAuxData auto-generates ephemeral keys (Issue #12)", async () => {
    const { client, publicClient, walletClient } = makeCDRClient();
    const conditionAddr = await deployOpenCondition(publicClient, walletClient);

    const globalPubKey = await client.observer.getGlobalPubKey();
    const dataKey = new Uint8Array(randomBytes(32));
    const { uuid } = await client.uploader.uploadCDR({
      dataKey,
      globalPubKey,
      updatable: false,
      writeConditionAddr: conditionAddr,
      readConditionAddr: conditionAddr,
      writeConditionData: "0x",
      readConditionData: "0x",
      accessAuxData: "0x",
    });
    expect(uuid).toBeGreaterThanOrEqual(0);

    const { dataKey: recovered, txHash } = await client.consumer.accessCDR({
      uuid,
      accessAuxData: "0x",
      timeoutMs: 180_000,
    });
    expect(Array.from(recovered)).toEqual(Array.from(dataKey));
    expect(txHash).toMatch(/^0x[0-9a-f]{64}$/);
  }, 240_000);

  // DX-03 is currently `it.skip` because it needs `@story-protocol/core-sdk`
  // to mint a license token, and that package is intentionally NOT a dep of
  // @piplabs/cdr-sdk (it's a heavy SDK that the published cdr-sdk shouldn't
  // pull in). The original story-cdr-e2e test wallet had it as a test-only
  // dep. Flipping this on is a follow-up: add `@story-protocol/core-sdk` to
  // packages/sdk devDependencies + change `it.skip` → `it`.
  it.skip("DX-03: LicenseReadCondition gates vault access to license holders (Issue #13, Aeneid only) — needs @story-protocol/core-sdk dep", async () => {
    const { publicClient, walletClient } = makeCDRClient();
    const chainId = await publicClient.getChainId();
    if (chainId !== 1315) {
      console.log(
        `DX-03 | SKIPPED: LicenseReadCondition only on Aeneid (chainId=${chainId})`,
      );
      return;
    }

    const LICENSE_READ_CONDITION =
      "0xC0640AD4CF2CaA9914C8e5C44234359a9102f7a3" as `0x${string}`;
    const OWNER_WRITE_CONDITION =
      "0x4C9bFC96d7092b590D497A191826C3dA2277c34B" as `0x${string}`;
    const LICENSE_TOKEN =
      "0xFe3838BFb30B34170F00030B52eA4893d8aAC6bC" as `0x${string}`;
    const WIP_TOKEN =
      "0x1514000000000000000000000000000000000000" as `0x${string}`;
    const ROYALTY_MODULE =
      "0xD2f60c40fEbccf6311f8B47c4f2Ec6b040400086" as `0x${string}`;
    const IP_ID =
      "0x3Aa560C9072E0D4A1443CD192745C24A176b4925" as `0x${string}`;
    const LICENSE_TERMS_ID = 2054;

    const uploaderAddr = privateKeyToAccount(PRIVATE_KEY!).address;
    const cdr = new CDRClient({
      network: "testnet",
      publicClient,
      walletClient,
      apiUrl: API_URL!,
    });

    const globalPubKey = await cdr.observer.getGlobalPubKey();
    const dataKey = new Uint8Array(randomBytes(32));
    const writeCondData = encodeAbiParameters(
      [{ type: "address" }],
      [uploaderAddr],
    );
    const readCondData = encodeAbiParameters(
      [{ type: "address" }, { type: "address" }],
      [LICENSE_TOKEN, IP_ID],
    );

    const { uuid } = await cdr.uploader.uploadCDR({
      dataKey,
      globalPubKey,
      updatable: false,
      writeConditionAddr: OWNER_WRITE_CONDITION,
      readConditionAddr: LICENSE_READ_CONDITION,
      writeConditionData: writeCondData,
      readConditionData: readCondData,
      accessAuxData: "0x",
    });

    // (a) Read without license fails.
    const emptyAux = encodeAbiParameters([{ type: "uint256[]" }], [[]]);
    await expect(
      cdr.consumer.accessCDR({
        uuid,
        accessAuxData: emptyAux,
        timeoutMs: 30_000,
      }),
    ).rejects.toThrow();

    // (b) Spin up a temp reader wallet, fund it, mint a license token,
    // then read with it.
    const readerKey = generatePrivateKey();
    const readerAccount = privateKeyToAccount(readerKey);

    const fundTx = await walletClient.sendTransaction({
      chain: walletClient.chain ?? null,
      account: walletClient.account ?? null,
      to: readerAccount.address,
      value: parseEther("5"),
    });
    await publicClient.waitForTransactionReceipt({ hash: fundTx });

    const readerWallet = createWalletClient({
      chain: walletClient.chain,
      transport: http(RPC_URL),
      account: readerAccount,
    }) as unknown as WalletClient;

    // Wrap 1 IP → WIP via WIP_TOKEN.deposit().
    const wrapTx = await readerWallet.sendTransaction({
      chain: readerWallet.chain ?? null,
      account: readerWallet.account ?? null,
      to: WIP_TOKEN,
      data: "0xd0e30db0" as `0x${string}`,
      value: parseEther("1"),
    });
    await publicClient.waitForTransactionReceipt({ hash: wrapTx });

    const approveTx = await readerWallet.writeContract({
      chain: readerWallet.chain ?? null,
      account: readerWallet.account ?? null,
      address: WIP_TOKEN,
      abi: [
        {
          type: "function",
          name: "approve",
          inputs: [{ type: "address" }, { type: "uint256" }],
          outputs: [{ type: "bool" }],
          stateMutability: "nonpayable",
        },
      ],
      functionName: "approve",
      args: [ROYALTY_MODULE, parseEther("1")],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveTx });

    // Mint a license token via Story Protocol SDK.
    // @ts-expect-error — @story-protocol/core-sdk is not a dep of @piplabs/cdr-sdk.
    // This `it.skip`'d test would need the dep added before it can run.
    const { StoryClient } = await import("@story-protocol/core-sdk");
    const storyClient = StoryClient.newClient({
      transport: http(RPC_URL),
      account: readerAccount,
    });
    const mintResult = await storyClient.license.mintLicenseTokens({
      licensorIpId: IP_ID,
      licenseTermsId: LICENSE_TERMS_ID,
      amount: 1,
      maxMintingFee: "100000000000000000",
      maxRevenueShare: 100,
    });
    const licenseTokenId = mintResult.licenseTokenIds![0];

    const readerCdr = new CDRClient({
      network: "testnet",
      publicClient,
      walletClient: readerWallet as unknown as WalletClient,
      apiUrl: API_URL!,
    });
    const accessAuxData = encodeAbiParameters(
      [{ type: "uint256[]" }],
      [[BigInt(licenseTokenId)]],
    );
    const { dataKey: recovered } = await readerCdr.consumer.accessCDR({
      uuid,
      accessAuxData: accessAuxData as `0x${string}`,
      timeoutMs: 180_000,
    });
    expect(toHex(new Uint8Array(recovered))).toBe(toHex(dataKey));

    // Best-effort cleanup: return remaining IP from reader to uploader.
    try {
      const bal = await publicClient.getBalance({
        address: readerAccount.address,
      });
      const gasCost = 21_000n * 1_000_007n;
      if (bal > gasCost * 2n) {
        const returnTx = await readerWallet.sendTransaction({
          chain: readerWallet.chain ?? null,
          account: readerWallet.account ?? null,
          to: uploaderAddr,
          value: bal - gasCost * 2n,
        });
        await publicClient.waitForTransactionReceipt({ hash: returnTx });
      }
    } catch {
      /* swallow cleanup errors — best-effort */
    }
  }, 300_000);

  it("DX-04: createVault / readVault method aliases exist (Issue #16)", () => {
    const { client } = makeCDRClient();
    expect(typeof client.uploader.createVault).toBe("function");
    expect(typeof client.uploader.createFileVault).toBe("function");
    expect(typeof client.consumer.readVault).toBe("function");
    expect(typeof client.consumer.readFileVault).toBe("function");
  });
});
