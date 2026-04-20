// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ICDRVaultCreator} from "./interfaces/ICDRVaultCreator.sol";

/// @title WhitelistCondition
/// @notice Generic CDR condition that gates vault access to an owner-managed allowlist.
///         Only the vault creator (verified via CDR.vaultCreator) can register and manage the whitelist.
contract WhitelistCondition {
    ICDRVaultCreator public immutable cdr;

    mapping(uint32 uuid => address creator) public vaultCreator;
    mapping(uint32 uuid => mapping(address => bool)) public isWhitelisted;

    error AlreadyRegistered();
    error NotCreator();
    error NotVaultCreator();

    constructor(address _cdr) {
        cdr = ICDRVaultCreator(_cdr);
    }

    /// @notice Register a vault UUID. Only the CDR vault creator can call.
    function register(uint32 uuid) external {
        if (vaultCreator[uuid] != address(0)) revert AlreadyRegistered();
        if (cdr.vaultCreator(uuid) != msg.sender) revert NotVaultCreator();
        vaultCreator[uuid] = msg.sender;
        isWhitelisted[uuid][msg.sender] = true;
    }

    /// @notice Register a vault and seed the whitelist. Only the CDR vault creator can call.
    function registerWithInitial(uint32 uuid, address[] calldata initial) external {
        if (vaultCreator[uuid] != address(0)) revert AlreadyRegistered();
        if (cdr.vaultCreator(uuid) != msg.sender) revert NotVaultCreator();
        vaultCreator[uuid] = msg.sender;
        isWhitelisted[uuid][msg.sender] = true;
        for (uint256 i = 0; i < initial.length; i++) {
            isWhitelisted[uuid][initial[i]] = true;
        }
    }

    /// @notice Add an address to the vault's whitelist. Only the creator can call.
    /// @param uuid The CDR vault UUID
    /// @param account The address to whitelist
    function addToWhitelist(uint32 uuid, address account) external {
        if (vaultCreator[uuid] != msg.sender) revert NotCreator();
        isWhitelisted[uuid][account] = true;
    }

    /// @notice Remove an address from the vault's whitelist. Only the creator can call.
    /// @param uuid The CDR vault UUID
    /// @param account The address to remove
    function removeFromWhitelist(uint32 uuid, address account) external {
        if (vaultCreator[uuid] != msg.sender) revert NotCreator();
        isWhitelisted[uuid][account] = false;
    }

    /// @notice CDR write condition check. Returns true if caller is whitelisted.
    function checkWriteCondition(
        uint32 uuid,
        bytes calldata,
        bytes calldata,
        address caller
    ) external view returns (bool) {
        return isWhitelisted[uuid][caller];
    }

    /// @notice CDR read condition check. Same logic as write.
    function checkReadCondition(
        uint32 uuid,
        bytes calldata,
        bytes calldata,
        address caller
    ) external view returns (bool) {
        return isWhitelisted[uuid][caller];
    }
}
