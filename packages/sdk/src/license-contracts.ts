/**
 * Minimal Story Protocol contract surface for license-token minting (#39).
 *
 * These are Story Protocol deployments, NOT part of the CDR system — kept
 * here (not in `@piplabs/cdr-contracts`) so that package stays purely CDR.
 * ABIs are the subset of functions/events this SDK calls; re-sync against
 * thedatafoundation/sdk `packages/core-sdk/src/abi/generated.ts`.
 *
 * All addresses are identical on Aeneid (1315) and mainnet (1514) —
 * deterministic deployments — so they are flat constants rather than a
 * per-network map.
 */

/** WIP — the immutable native-token wrapper (pre-rebrand name; wraps native $DATA). */
export const WIP_ADDRESS =
  "0x1514000000000000000000000000000000000000" as const;

/** Story Protocol LicensingModule — mints license tokens against license terms. */
export const LICENSING_MODULE_ADDRESS =
  "0x04fbd8a2e56dd85CFD5500A4A4DfA955B9f1dE6f" as const;

/** Story Protocol RoyaltyModule — pulls the minting fee via WIP `transferFrom`. */
export const ROYALTY_MODULE_ADDRESS =
  "0xD2f60c40fEbccf6311f8B47c4f2Ec6b040400086" as const;

/** Story Protocol PILicenseTemplate — the default `licenseTemplate` for terms. */
export const PI_LICENSE_TEMPLATE_ADDRESS =
  "0x2E896b0b2Fdb7457499B56AAaA4AE55BCB4Cd316" as const;

export const wipAbi = [
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "allowance",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "deposit",
    inputs: [],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
] as const;

export const licensingModuleAbi = [
  {
    type: "function",
    name: "predictMintingLicenseFee",
    inputs: [
      { name: "licensorIpId", type: "address" },
      { name: "licenseTemplate", type: "address" },
      { name: "licenseTermsId", type: "uint256" },
      { name: "amount", type: "uint256" },
      { name: "receiver", type: "address" },
      { name: "royaltyContext", type: "bytes" },
    ],
    outputs: [
      { name: "currencyToken", type: "address" },
      { name: "tokenAmount", type: "uint256" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "mintLicenseTokens",
    inputs: [
      { name: "licensorIpId", type: "address" },
      { name: "licenseTemplate", type: "address" },
      { name: "licenseTermsId", type: "uint256" },
      { name: "amount", type: "uint256" },
      { name: "receiver", type: "address" },
      { name: "royaltyContext", type: "bytes" },
      { name: "maxMintingFee", type: "uint256" },
      { name: "maxRevenueShare", type: "uint32" },
    ],
    outputs: [{ name: "startLicenseTokenId", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  {
    type: "event",
    name: "LicenseTokensMinted",
    anonymous: false,
    inputs: [
      { name: "caller", type: "address", indexed: true },
      { name: "licensorIpId", type: "address", indexed: true },
      { name: "licenseTemplate", type: "address", indexed: false },
      { name: "licenseTermsId", type: "uint256", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "receiver", type: "address", indexed: false },
      { name: "startLicenseTokenId", type: "uint256", indexed: false },
    ],
  },
] as const;
