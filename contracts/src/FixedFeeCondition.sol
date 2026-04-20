// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ICDRVaultCreator} from "./interfaces/ICDRVaultCreator.sol";

/// @title FixedFeeCondition
/// @notice Generic CDR condition that gates vault access behind a one-time fee.
///         Only the vault creator (verified via CDR.vaultCreator) can register.
contract FixedFeeCondition {
    ICDRVaultCreator public immutable cdr;

    mapping(uint32 uuid => address creator) public vaultCreator;
    mapping(uint32 uuid => uint256 fee) public vaultFee;
    mapping(uint32 uuid => mapping(address => bool)) public hasPaid;
    mapping(address creator => uint256 balance) public creatorBalance;

    error AlreadyRegistered();
    error NotRegistered();
    error InsufficientFee();
    error AlreadyPaid();
    error NothingToWithdraw();
    error TransferFailed();
    error NotVaultCreator();

    constructor(address _cdr) {
        cdr = ICDRVaultCreator(_cdr);
    }

    /// @notice Register a vault UUID with a fixed access fee. Only the CDR vault creator can call.
    function register(uint32 uuid, uint256 fee) external {
        if (vaultCreator[uuid] != address(0)) revert AlreadyRegistered();
        if (cdr.vaultCreator(uuid) != msg.sender) revert NotVaultCreator();
        vaultCreator[uuid] = msg.sender;
        vaultFee[uuid] = fee;
    }

    /// @notice Pay the fee to gain access to a vault.
    /// @param uuid The CDR vault UUID
    function payFee(uint32 uuid) external payable {
        address creator = vaultCreator[uuid];
        if (creator == address(0)) revert NotRegistered();
        if (hasPaid[uuid][msg.sender]) revert AlreadyPaid();

        uint256 fee = vaultFee[uuid];
        if (msg.value < fee) revert InsufficientFee();

        hasPaid[uuid][msg.sender] = true;
        creatorBalance[creator] += fee;

        // Refund excess
        uint256 excess = msg.value - fee;
        if (excess > 0) {
            (bool sent, ) = msg.sender.call{value: excess}("");
            if (!sent) revert TransferFailed();
        }
    }

    /// @notice Withdraw accumulated fees.
    function withdraw() external {
        uint256 amount = creatorBalance[msg.sender];
        if (amount == 0) revert NothingToWithdraw();

        creatorBalance[msg.sender] = 0;
        (bool sent, ) = msg.sender.call{value: amount}("");
        if (!sent) revert TransferFailed();
    }

    /// @notice CDR write condition check. Returns true if caller is creator or has paid.
    function checkWriteCondition(
        uint32 uuid,
        bytes calldata,
        bytes calldata,
        address caller
    ) external view returns (bool) {
        if (vaultCreator[uuid] == caller) return true;
        return hasPaid[uuid][caller];
    }

    /// @notice CDR read condition check. Same logic as write.
    function checkReadCondition(
        uint32 uuid,
        bytes calldata,
        bytes calldata,
        address caller
    ) external view returns (bool) {
        if (vaultCreator[uuid] == caller) return true;
        return hasPaid[uuid][caller];
    }
}
