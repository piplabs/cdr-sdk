// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {WhitelistCondition} from "../src/WhitelistCondition.sol";
import {FixedFeeCondition} from "../src/FixedFeeCondition.sol";
import {TimeBasedCondition} from "../src/TimeBasedCondition.sol";
import {ICDRVaultCreator} from "../src/interfaces/ICDRVaultCreator.sol";

/// @notice Mock CDR contract that implements vaultCreator() for testing.
contract MockCDR is ICDRVaultCreator {
    mapping(uint32 => address) public override vaultCreator;

    function setVaultCreator(uint32 uuid, address creator) external {
        vaultCreator[uuid] = creator;
    }
}

/// @title RegisterFrontrunTest
/// @notice Tests that register() front-run attack is blocked after fix.
///         The fix: condition contracts verify msg.sender == CDR.vaultCreator(uuid).
contract RegisterFrontrunTest is Test {
    MockCDR internal mockCDR;
    WhitelistCondition internal wl;
    FixedFeeCondition internal ff;
    TimeBasedCondition internal tb;

    address internal creator = address(0xC0FFEE);
    address internal attacker = address(0xDEAD);
    uint32 internal constant UUID = 42;

    function setUp() public {
        mockCDR = new MockCDR();
        wl = new WhitelistCondition(address(mockCDR));
        ff = new FixedFeeCondition(address(mockCDR));
        tb = new TimeBasedCondition(address(mockCDR));

        // Simulate: creator called CDR.allocate() → CDR recorded them as vault creator
        mockCDR.setVaultCreator(UUID, creator);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // WhitelistCondition
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Attacker cannot front-run register() — reverts with NotVaultCreator.
    function test_whitelist_attackerCannotRegister() public {
        vm.prank(attacker);
        vm.expectRevert(WhitelistCondition.NotVaultCreator.selector);
        wl.register(UUID);
    }

    /// @notice Real vault creator can register successfully.
    function test_whitelist_creatorCanRegister() public {
        vm.prank(creator);
        wl.register(UUID);

        assertEq(wl.vaultCreator(UUID), creator, "creator registered");
        assertTrue(wl.isWhitelisted(UUID, creator), "creator whitelisted");
        assertFalse(wl.isWhitelisted(UUID, attacker), "attacker not whitelisted");
    }

    /// @notice Full attack scenario: attacker tries to front-run, fails, creator succeeds.
    function test_whitelist_fullAttackScenario() public {
        // Step 1: Attacker tries to front-run → BLOCKED
        vm.prank(attacker);
        vm.expectRevert(WhitelistCondition.NotVaultCreator.selector);
        wl.register(UUID);

        // Step 2: Creator registers → succeeds
        vm.prank(creator);
        wl.register(UUID);

        // Step 3: Creator controls whitelist, attacker does not
        vm.prank(creator);
        wl.addToWhitelist(UUID, address(0xBEEF));
        assertTrue(wl.isWhitelisted(UUID, address(0xBEEF)));

        vm.prank(attacker);
        vm.expectRevert(WhitelistCondition.NotCreator.selector);
        wl.addToWhitelist(UUID, attacker);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // FixedFeeCondition
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Attacker cannot front-run register() with fee=0.
    function test_fixedFee_attackerCannotRegister() public {
        vm.prank(attacker);
        vm.expectRevert(FixedFeeCondition.NotVaultCreator.selector);
        ff.register(UUID, 0);
    }

    /// @notice Creator registers with correct fee.
    function test_fixedFee_creatorCanRegister() public {
        vm.prank(creator);
        ff.register(UUID, 1 ether);

        assertEq(ff.vaultCreator(UUID), creator, "creator registered");
        assertEq(ff.vaultFee(UUID), 1 ether, "fee = 1 ether");
    }

    /// @notice Full attack scenario: attacker fee=0 blocked, creator fee=1eth works.
    function test_fixedFee_fullAttackScenario() public {
        // Attacker tries fee=0 → BLOCKED
        vm.prank(attacker);
        vm.expectRevert(FixedFeeCondition.NotVaultCreator.selector);
        ff.register(UUID, 0);

        // Creator sets proper fee
        vm.prank(creator);
        ff.register(UUID, 1 ether);
        assertEq(ff.vaultFee(UUID), 1 ether);

        // User must pay 1 ether to access
        address user = address(0xF00D);
        vm.deal(user, 2 ether);
        vm.prank(user);
        ff.payFee{value: 1 ether}(UUID);
        assertTrue(ff.checkReadCondition(UUID, "", "", user), "paid user can read");

        // Freeloader without payment cannot
        assertFalse(ff.checkReadCondition(UUID, "", "", address(0xBAD)), "unpaid cannot read");
    }

    // ═══════════════════════════════════════════════════════════════════════
    // TimeBasedCondition
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Attacker cannot front-run register() with expired window (DoS).
    function test_timeBased_attackerCannotRegister_DoS() public {
        vm.warp(1700000000);
        vm.prank(attacker);
        vm.expectRevert(TimeBasedCondition.NotVaultCreator.selector);
        tb.register(UUID, 0, 1);
    }

    /// @notice Attacker cannot front-run register() with open window.
    function test_timeBased_attackerCannotRegister_OpenAccess() public {
        vm.prank(attacker);
        vm.expectRevert(TimeBasedCondition.NotVaultCreator.selector);
        tb.register(UUID, 0, 0);
    }

    /// @notice Creator registers valid time window.
    function test_timeBased_creatorCanRegister() public {
        vm.warp(1700000000);
        vm.prank(creator);
        tb.register(UUID, block.timestamp, block.timestamp + 30 days);

        (uint256 start, uint256 end, bool reg) = tb.vaultTimeWindow(UUID);
        assertTrue(reg, "registered");
        assertEq(start, 1700000000);
        assertEq(end, 1700000000 + 30 days);
    }

    /// @notice Full attack scenario: DoS blocked, creator sets proper window.
    function test_timeBased_fullAttackScenario() public {
        vm.warp(1700000000);

        // Attacker DoS attempt → BLOCKED
        vm.prank(attacker);
        vm.expectRevert(TimeBasedCondition.NotVaultCreator.selector);
        tb.register(UUID, 0, 1);

        // Creator sets proper 30-day window
        vm.prank(creator);
        tb.register(UUID, block.timestamp, block.timestamp + 30 days);

        // Access works within window
        assertTrue(tb.checkWriteCondition(UUID, "", "", creator), "within window");

        // Access fails after window
        vm.warp(1700000000 + 31 days);
        assertFalse(tb.checkWriteCondition(UUID, "", "", creator), "after window");
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Edge: unregistered UUID (no CDR vault creator set)
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice register() on UUID with no CDR vault creator → reverts.
    function test_unregisteredUUID_reverts() public {
        uint32 unknownUUID = 999;
        // mockCDR.vaultCreator(999) == address(0) → msg.sender != address(0) → revert

        vm.prank(creator);
        vm.expectRevert(WhitelistCondition.NotVaultCreator.selector);
        wl.register(unknownUUID);

        vm.prank(creator);
        vm.expectRevert(FixedFeeCondition.NotVaultCreator.selector);
        ff.register(unknownUUID, 1 ether);

        vm.prank(creator);
        vm.expectRevert(TimeBasedCondition.NotVaultCreator.selector);
        tb.register(unknownUUID, 0, 0);
    }
}
