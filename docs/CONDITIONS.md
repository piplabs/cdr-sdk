# Write and Read Condition Contracts

Vaults use **condition contracts** to control who can write data and who can request reads. When you allocate a vault, you specify a write condition address and a read condition address. The CDR contract calls into these before allowing the operation.

## Deployed Contracts (Aeneid Testnet)

The following condition contracts are deployed on Aeneid (chain ID 1315) and ready to use:

| Contract | Address | Type | Description |
|----------|---------|------|-------------|
| OwnerWriteCondition | `0x4C9bFC96d7092b590D497A191826C3dA2277c34B` | Write | Only the address encoded in `writeConditionData` can write |
| LicenseReadCondition | `0xC0640AD4CF2CaA9914C8e5C44234359a9102f7a3` | Read | Only Story Protocol license token holders for the specified IP can read |

### OwnerWriteCondition Usage

```typescript
import { encodeAbiParameters } from "viem";

const writeCondData = encodeAbiParameters(
  [{ type: "address" }],
  [uploaderAddress],  // Only this address can write
);

await client.uploader.uploadCDR({
  // ...
  writeConditionAddr: "0x4C9bFC96d7092b590D497A191826C3dA2277c34B",
  writeConditionData: writeCondData,
});
```

### LicenseReadCondition Usage

At upload time, encode the LicenseToken contract address and IP ID:

```typescript
const readCondData = encodeAbiParameters(
  [{ type: "address" }, { type: "address" }],
  [
    "0xFe3838BFb30B34170F00030B52eA4893d8aAC6bC",  // LicenseToken contract
    "0x3Aa560C9072E0D4A1443CD192745C24A176b4925",  // Your IP ID
  ],
);

await client.uploader.uploadCDR({
  // ...
  readConditionAddr: "0xC0640AD4CF2CaA9914C8e5C44234359a9102f7a3",
  readConditionData: readCondData,
});
```

At read time, pass the license token IDs as `accessAuxData`:

```typescript
const accessAuxData = encodeAbiParameters(
  [{ type: "uint256[]" }],
  [[BigInt(licenseTokenId)]],
);

const { dataKey } = await client.consumer.accessCDR({
  uuid,
  accessAuxData,
  timeoutMs: 120_000,
});
```


---

## How Conditions Work

When someone calls `write()` or `read()` on the CDR contract, the contract:

1. Looks up the vault's condition address (`writeConditionAddr` or `readConditionAddr`)
2. Calls the condition contract with the caller's address, the condition data stored at allocation time, and the `accessAuxData` provided by the caller
3. If the condition contract returns false (or reverts), the operation is rejected

This happens at the protocol level — the SDK does not enforce conditions locally. Your transaction will revert on-chain if conditions aren't met.

## Expected Interface

Condition contracts must implement these functions:

```solidity
// For write conditions
function checkWriteCondition(
    address caller,
    bytes calldata conditionData,
    bytes calldata accessAuxData
) external view returns (bool);

// For read conditions
function checkReadCondition(
    address caller,
    bytes calldata conditionData,
    bytes calldata accessAuxData
) external view returns (bool);
```

**Parameters:**

| Parameter | Source | Description |
|-----------|--------|-------------|
| `caller` | `msg.sender` of the CDR write/read call | The address attempting the operation |
| `conditionData` | Stored at vault allocation time | Static config set by the vault creator (e.g., an allowlist root, a token address, a role identifier) |
| `accessAuxData` | Passed by the caller at write/read time | Dynamic data the caller provides to satisfy the condition (e.g., a Merkle proof, a signature) |

## How to Set Conditions

Conditions are set once when allocating a vault:

```typescript
const { uuid } = await client.uploader.allocate({
  updatable: false,
  writeConditionAddr: "0xYourWriteConditionContract",
  readConditionAddr: "0xYourReadConditionContract",
  writeConditionData: "0x...",  // encoded config for your write condition
  readConditionData: "0x...",   // encoded config for your read condition
});
```

Then callers pass `accessAuxData` when writing or reading:

```typescript
// Writer passes proof data
await client.uploader.write({
  uuid,
  accessAuxData: "0x...",  // e.g., Merkle proof that caller is on the allowlist
  encryptedData: "0x...",
});

// Reader passes proof data
await client.consumer.read({
  uuid,
  accessAuxData: "0x...",  // e.g., signature proving token ownership
  requesterPubKey: "0x...",
});
```

If your conditions don't need extra data, pass `"0x"` for both `conditionData` and `accessAuxData`.

## Example Conditions

### Open Access (No Restriction)

A condition that always returns true. Useful for testing or public vaults.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract OpenCondition {
    function checkWriteCondition(
        address,
        bytes calldata,
        bytes calldata
    ) external pure returns (bool) {
        return true;
    }

    function checkReadCondition(
        address,
        bytes calldata,
        bytes calldata
    ) external pure returns (bool) {
        return true;
    }
}
```

### Owner-Only

Only the vault creator (encoded in `conditionData`) can operate.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract OwnerCondition {
    function checkWriteCondition(
        address caller,
        bytes calldata conditionData,
        bytes calldata
    ) external pure returns (bool) {
        address owner = abi.decode(conditionData, (address));
        return caller == owner;
    }

    function checkReadCondition(
        address caller,
        bytes calldata conditionData,
        bytes calldata
    ) external pure returns (bool) {
        address owner = abi.decode(conditionData, (address));
        return caller == owner;
    }
}
```

To use this, encode the owner address into `conditionData` at allocation:

```typescript
import { encodeAbiParameters } from "viem";

const conditionData = encodeAbiParameters(
  [{ type: "address" }],
  ["0xYourAddress"]
);

await client.uploader.allocate({
  updatable: false,
  writeConditionAddr: ownerConditionAddress,
  readConditionAddr: ownerConditionAddress,
  writeConditionData: conditionData,
  readConditionData: conditionData,
});
```

### ERC-20 Token Gate

Require the caller to hold a minimum balance of a specific token.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract TokenGateCondition {
    function checkReadCondition(
        address caller,
        bytes calldata conditionData,
        bytes calldata
    ) external view returns (bool) {
        (address token, uint256 minBalance) = abi.decode(conditionData, (address, uint256));
        return IERC20(token).balanceOf(caller) >= minBalance;
    }

    function checkWriteCondition(
        address caller,
        bytes calldata conditionData,
        bytes calldata
    ) external view returns (bool) {
        (address token, uint256 minBalance) = abi.decode(conditionData, (address, uint256));
        return IERC20(token).balanceOf(caller) >= minBalance;
    }
}
```

### Allowlist with Merkle Proof

The vault creator stores a Merkle root in `conditionData`. Callers provide a proof in `accessAuxData`.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

contract MerkleCondition {
    function checkReadCondition(
        address caller,
        bytes calldata conditionData,
        bytes calldata accessAuxData
    ) external pure returns (bool) {
        bytes32 root = abi.decode(conditionData, (bytes32));
        bytes32[] memory proof = abi.decode(accessAuxData, (bytes32[]));
        bytes32 leaf = keccak256(abi.encodePacked(caller));
        return MerkleProof.verify(proof, root, leaf);
    }

    function checkWriteCondition(
        address caller,
        bytes calldata conditionData,
        bytes calldata accessAuxData
    ) external pure returns (bool) {
        bytes32 root = abi.decode(conditionData, (bytes32));
        bytes32[] memory proof = abi.decode(accessAuxData, (bytes32[]));
        bytes32 leaf = keccak256(abi.encodePacked(caller));
        return MerkleProof.verify(proof, root, leaf);
    }
}
```

## Asymmetric Conditions

You don't have to use the same contract or logic for reads and writes. Common patterns:

- **Owner writes, public reads** — `OwnerCondition` for write, `OpenCondition` for read
- **Anyone writes, token holders read** — `OpenCondition` for write, `TokenGateCondition` for read
- **Allowlisted writers, owner reads** — `MerkleCondition` for write, `OwnerCondition` for read

## Debugging Condition Failures

If your `write()` or `read()` transaction reverts, the condition contract rejected it. To debug:

1. **Check the condition contract address** — Is it deployed? Does it implement the expected function?
2. **Simulate the call** — Use viem's `simulateContract` to see the revert reason before sending a transaction.
3. **Verify `conditionData`** — Was it encoded correctly at allocation time? Read the vault back with `observer.getVault(uuid)` and check `writeConditionData` / `readConditionData`.
4. **Verify `accessAuxData`** — Is the caller providing the right proof/signature/data?

```typescript
// Read back vault to inspect stored conditions
const vault = await client.observer.getVault(uuid);
console.log("Write condition:", vault.writeConditionAddr);
console.log("Write condition data:", vault.writeConditionData);
console.log("Read condition:", vault.readConditionAddr);
console.log("Read condition data:", vault.readConditionData);
```
