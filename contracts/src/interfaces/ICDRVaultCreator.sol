// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Minimal interface for querying vault creator from CDR contract.
///         CDR.sol needs to add `address creator` to Vault struct and expose this view.
interface ICDRVaultCreator {
    function vaultCreator(uint32 uuid) external view returns (address);
}
