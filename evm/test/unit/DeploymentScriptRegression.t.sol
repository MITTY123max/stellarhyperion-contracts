// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Execute} from "../../script/Execute.s.sol";
import {Verify} from "../../script/Verify.s.sol";
import {HyperionRouter} from "../../src/HyperionRouter.sol";
import {ActionKind, AdminAction} from "../../src/HyperionTypes.sol";
import {CctpAdapter} from "../../src/adapters/CctpAdapter.sol";
import {Fixture} from "../Fixture.sol";

contract GuardianEvidenceHarness is Verify {
    function reconstruct(string calldata logs, address router, bytes32 role)
        external
        view
        returns (uint256 used, uint256 count, address first, bool activeFirst)
    {
        address[] memory members = new address[](128);
        bool[] memory active = new bool[](128);
        (used, count) = _applyGuardianLogs(logs, router, role, members, active, 0, 0);
        return (used, count, members[0], active[0]);
    }
}

// Unit fixtures have no RPC fork. Supply an explicit public genesis identity while
// the real deployment rehearsal exercises canonical header retrieval.
contract GenesisExecuteHarness is Execute {
    function observedGenesisBlockHash() internal pure override returns (bytes32) {
        return bytes32(uint256(9));
    }
}

contract GenesisVerifyHarness is Verify {
    function observedGenesisBlockHash() internal pure override returns (bytes32) {
        return bytes32(uint256(9));
    }
}

contract DeploymentScriptRegressionTest is Fixture {
    string private constant RECORD = "deployments/unit-execution-record.json";

    // These scenarios share Foundry's process-wide environment and real record files. Run them
    // together so the default parallel test runner cannot cross-write their inputs.
    function test_recordExecutionAndUnsignedVerificationScenarios() public {
        _reportOnlyLeavesUnmappedPhaseOneUntouchedWithoutProviders();
        _staleProviderFailsBeforeAnyActionOrBroadcast();
        _actionIdBeyondUint64IsRejectedBeforeReportOrBroadcast();
        _unsignedVerifyValidatesPublicArtifactsAndRecordWithoutLiveCodeOrSigner();
    }

    function _unsignedVerifyValidatesPublicArtifactsAndRecordWithoutLiveCodeOrSigner() private {
        uint256 originalChain = block.chainid;
        _unsignedRecord();
        vm.setEnv("HYPERION_DRY_RUN", "true");
        vm.setEnv("PRIVATE_KEY", "deliberately-invalid-signer-input");
        vm.setEnv("HYPERION_ROUTER_ARTIFACT_HASH", vm.toString(keccak256(type(HyperionRouter).creationCode)));
        vm.setEnv("HYPERION_CCTP_ARTIFACT_HASH", vm.toString(keccak256(type(CctpAdapter).creationCode)));
        vm.setEnv("CCTP_TOKEN_MESSENGER_CODE_HASH", vm.toString(bytes32(uint256(1))));
        vm.setEnv("CCTP_MESSAGE_TRANSMITTER_CODE_HASH", vm.toString(bytes32(uint256(2))));
        Verify verify = new GenesisVerifyHarness();
        uint64 count = router.actionCount();
        verify.run();
        assertEq(router.actionCount(), count);
        assertEq(router.feeBps(), FEE_BPS);
        vm.setEnv("HYPERION_ROUTER_ARTIFACT_HASH", vm.toString(bytes32(0)));
        vm.expectRevert("missing reviewed artifact identity");
        verify.run();
        vm.setEnv("HYPERION_ROUTER_ARTIFACT_HASH", vm.toString(bytes32(uint256(9))));
        vm.expectRevert("artifact differs from reviewed identity");
        verify.run();
        vm.setEnv("HYPERION_ROUTER_ARTIFACT_HASH", vm.toString(keccak256(type(HyperionRouter).creationCode)));
        vm.setEnv("CCTP_TOKEN_MESSENGER_CODE_HASH", vm.toString(bytes32(0)));
        vm.expectRevert("missing reviewed provider identity");
        verify.run();
        vm.chainId(999_999);
        vm.expectRevert("unsupported deployment chain");
        verify.run();
        vm.chainId(originalChain);
        vm.setEnv("HYPERION_DRY_RUN", "false");
        vm.removeFile("deployments/unit-unsigned-verification-record.json");
    }

    function _unsignedRecord() private {
        string memory key = "unsigned-verification-record";
        string memory path = "deployments/unit-unsigned-verification-record.json";
        vm.setEnv("HYPERION_RECORD", path);
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeBytes32(key, "genesisBlockHash", bytes32(uint256(9)));
        vm.serializeAddress(key, "router", address(router));
        vm.serializeAddress(key, "cctpAdapter", address(0xCC70));
        vm.serializeAddress(key, "token", address(usdc));
        vm.serializeAddress(key, "admin", admin);
        vm.serializeAddress(key, "guardian", guardian);
        vm.serializeAddress(key, "treasury", treasury);
        vm.serializeAddress(key, "deployer", admin);
        vm.serializeUint(key, "feeBps", FEE_BPS);
        vm.serializeUint(key, "timelockDelay", TIMELOCK);
        vm.serializeUint(key, "flowWindow", FLOW_WINDOW);
        vm.serializeUint(key, "tokenDecimals", USDC_DECIMALS);
        vm.serializeUint(key, "tokenFlowLimit", FLOW_LIMIT);
        vm.serializeString(key, "stellarChain", "stellar-testnet");
        vm.serializeBytes32(key, "stellarRailRecipient", bytes32(uint256(3)));
        vm.serializeString(key, "evmVersion", "cancun");
        vm.serializeString(key, "solcVersion", "0.8.28+commit.7893614a");
        vm.serializeUint(key, "optimizerRuns", 200);
        vm.serializeBool(key, "viaIR", true);
        vm.serializeAddress(key, "cctpTokenMessenger", address(0xCC71));
        vm.serializeAddress(key, "cctpMessageTransmitter", address(0xCC72));
        vm.serializeAddress(
            key,
            "provenanceStore",
            address(uint160(uint256(keccak256(abi.encodePacked(hex"d694", address(router), hex"01")))))
        );
        vm.serializeBytes32(key, "provenanceStoreCodeHash", bytes32(uint256(4)));
        string memory output = vm.serializeUint(key, "deployedAtBlock", block.number);
        vm.writeFile(path, output);
    }

    function _reportOnlyLeavesUnmappedPhaseOneUntouchedWithoutProviders() private {
        HyperionRouter fresh = _freshRouter();
        AdminAction memory action = _empty(ActionKind.SetFeeBps);
        action.amount = 20;
        vm.prank(admin);
        uint64 id = fresh.queueAction(action);
        _record(fresh, id);
        vm.setEnv("HYPERION_REPORT_ONLY", "true");
        Execute execute = new GenesisExecuteHarness();
        execute.run();
        assertFalse(fresh.queuedAction(id).executed);
        assertEq(fresh.feeBps(), FEE_BPS);
        vm.setEnv("HYPERION_REPORT_ONLY", "false");
    }

    function _staleProviderFailsBeforeAnyActionOrBroadcast() private {
        HyperionRouter fresh = _freshRouter();
        AdminAction memory action = _empty(ActionKind.SetFeeBps);
        action.amount = 20;
        vm.prank(admin);
        uint64 id = fresh.queueAction(action);
        _record(fresh, id);
        vm.setEnv("HYPERION_REPORT_ONLY", "false");
        vm.warp(block.timestamp + TIMELOCK + 1);
        Execute execute = new GenesisExecuteHarness();
        vm.expectRevert("record token has no code");
        execute.run();
        assertFalse(fresh.queuedAction(id).executed);
        assertEq(fresh.feeBps(), FEE_BPS);
    }

    function _actionIdBeyondUint64IsRejectedBeforeReportOrBroadcast() private {
        _record(router, uint256(type(uint64).max) + 1);
        vm.setEnv("HYPERION_REPORT_ONLY", "true");
        Execute execute = new GenesisExecuteHarness();
        vm.expectRevert("action id exceeds uint64");
        execute.run();
        vm.setEnv("HYPERION_REPORT_ONLY", "false");
    }

    function test_guardianEvidenceReconstructsZeroGrantDuplicateAndRevoke() public {
        GuardianEvidenceHarness harness = new GuardianEvidenceHarness();
        bytes32 role = router.GUARDIAN_ROLE();
        (uint256 used, uint256 count,,) = harness.reconstruct("[]", address(router), role);
        assertEq(used, 0);
        assertEq(count, 0);
        string memory grant = _event(keccak256("RoleGranted(bytes32,address,address)"), role, false, 4);
        (used, count,,) =
            harness.reconstruct(string.concat("[", grant, ",", grant, "]"), address(router), role);
        assertEq(used, 1);
        assertEq(count, 1, "hidden grant invalidates absent-guardian policy");
        string memory revoke = _event(keccak256("RoleRevoked(bytes32,address,address)"), role, false, 4);
        bool active;
        (used, count,, active) =
            harness.reconstruct(string.concat("[", grant, ",", revoke, "]"), address(router), role);
        assertEq(used, 1);
        assertEq(count, 0);
        assertFalse(active);
    }

    function test_guardianEvidenceFailsClosedForIncompleteWrongRoleAndRemovedLogs() public {
        GuardianEvidenceHarness harness = new GuardianEvidenceHarness();
        bytes32 role = router.GUARDIAN_ROLE();
        vm.expectRevert("guardian RPC did not return a complete bounded array");
        harness.reconstruct("[", address(router), role);
        vm.expectRevert("guardian event identity differs");
        harness.reconstruct(
            string.concat(
                "[", _event(keccak256("RoleGranted(bytes32,address,address)"), bytes32(0), false, 4), "]"
            ),
            address(router),
            role
        );
        vm.expectRevert("removed guardian event is not canonical evidence");
        harness.reconstruct(
            string.concat("[", _event(keccak256("RoleGranted(bytes32,address,address)"), role, true, 4), "]"),
            address(router),
            role
        );
        vm.expectRevert("guardian event identity differs");
        harness.reconstruct(
            string.concat(
                "[", _event(keccak256("RoleGranted(bytes32,address,address)"), role, false, 3), "]"
            ),
            address(router),
            role
        );
    }

    function _record(HyperionRouter target, uint256 id) private {
        vm.setEnv("HYPERION_RECORD", RECORD);
        vm.writeFile(
            RECORD,
            string.concat(
                "{\"genesisBlockHash\":\"",
                vm.toString(bytes32(uint256(9))),
                "\",\"chainId\":",
                vm.toString(block.chainid),
                ",\"router\":\"",
                vm.toString(address(target)),
                "\",\"queuedActionIds\":[",
                vm.toString(id),
                "],\"queuedActions\":[\"reviewed action\"],\"token\":\"",
                vm.toString(stranger),
                "\"}"
            )
        );
    }

    function _event(bytes32 kind, bytes32 role, bool removed, uint256 topics)
        private
        view
        returns (string memory)
    {
        return string.concat(
            "{\"address\":\"",
            vm.toString(address(router)),
            "\",\"topics\":[\"",
            vm.toString(kind),
            "\",\"",
            vm.toString(role),
            "\",\"",
            vm.toString(bytes32(uint256(uint160(guardian)))),
            topics == 4 ? string.concat("\",\"", vm.toString(bytes32(uint256(uint160(admin))))) : "",
            "\"],\"removed\":",
            removed ? "true" : "false",
            ",\"data\":\"0x\"}"
        );
    }
}
