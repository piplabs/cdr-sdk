// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ICDRVaultCreator} from "./interfaces/ICDRVaultCreator.sol";

/// @title TimeBasedCondition
/// @notice Generic CDR condition that gates vault access to a specific time window.
///         Only the vault creator (verified via CDR.vaultCreator) can register.
contract TimeBasedCondition {
    ICDRVaultCreator public immutable cdr;

    struct TimeWindow {
        uint256 startTime;
        uint256 endTime;
        bool registered;
    }

    mapping(uint32 uuid => TimeWindow) public vaultTimeWindow;

    error AlreadyRegistered();
    error InvalidTimeWindow();
    error NotVaultCreator();

    constructor(address _cdr) {
        cdr = ICDRVaultCreator(_cdr);
    }

    /// @notice Register a vault UUID with an immutable time window. Only the CDR vault creator can call.
    function register(uint32 uuid, uint256 startTime, uint256 endTime) external {
        if (vaultTimeWindow[uuid].registered) revert AlreadyRegistered();
        if (cdr.vaultCreator(uuid) != msg.sender) revert NotVaultCreator();
        if (endTime != 0 && endTime <= startTime) revert InvalidTimeWindow();

        vaultTimeWindow[uuid] = TimeWindow({
            startTime: startTime,
            endTime: endTime,
            registered: true
        });
    }

    /// @notice CDR write condition check. Returns true if current time is within the window.
    function checkWriteCondition(
        uint32 uuid,
        bytes calldata,
        bytes calldata,
        address
    ) external view returns (bool) {
        return _isWithinWindow(uuid);
    }

    /// @notice CDR read condition check. Same logic as write.
    function checkReadCondition(
        uint32 uuid,
        bytes calldata,
        bytes calldata,
        address
    ) external view returns (bool) {
        return _isWithinWindow(uuid);
    }

    function _isWithinWindow(uint32 uuid) internal view returns (bool) {
        TimeWindow storage tw = vaultTimeWindow[uuid];
        if (!tw.registered) return false;
        if (block.timestamp < tw.startTime) return false;
        if (tw.endTime != 0 && block.timestamp > tw.endTime) return false;
        return true;
    }
}
