// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {stdJson} from "forge-std/StdJson.sol";
import {console} from "forge-std/console.sol";

import {HyperionRouter} from "../src/HyperionRouter.sol";
import {RouteKind} from "../src/HyperionTypes.sol";
import {OutboundProvenance} from "../src/OutboundProvenance.sol";
import {TokenRecoveryManager} from "../src/TokenRecoveryManager.sol";
import {AxelarItsAdapter} from "../src/adapters/AxelarItsAdapter.sol";
import {CctpAdapter} from "../src/adapters/CctpAdapter.sol";

import {DeployConfig} from "./DeployConfig.sol";

/// @title Read a live deployment back and check it against the record
/// @author dotmantissa
/// @notice Signs nothing and sends nothing. Every value below is read off the chain and compared
/// against the file, and the script fails if any of them disagree.
///
/// Worth having as its own script rather than a tail on the deploy, because the question "is the
/// thing on chain still what we wrote down" is one somebody asks weeks later, during an incident,
/// from a laptop that never ran the deployment. It should not require reading nine `cast call`
/// invocations off a wiki.
///
/// Usage:
///   forge script script/Verify.s.sol --rpc-url $RPC
contract Verify is DeployConfig {
    using stdJson for string;

    uint256 internal problems;

    function run() external {
        if (vm.envOr("HYPERION_DRY_RUN", false)) {
            _unsignedPlan();
            return;
        }
        problems = 0;
        string memory path = vm.envOr(
            "HYPERION_RECORD", string.concat("deployments/evm-", vm.toString(block.chainid), "-phase1.json")
        );
        string memory record = vm.readFile(path);

        HyperionRouter router = HyperionRouter(payable(record.readAddress(".router")));
        CctpAdapter cctp = CctpAdapter(payable(record.readAddress(".cctpAdapter")));

        console.log("record              ", path);
        console.log("router              ", address(router));
        console.log("");

        _expectUint("chain id", block.chainid, record.readUint(".chainId"));
        bytes32 observedGenesis = observedGenesisBlockHash();
        if (vm.keyExistsJson(record, ".genesisBlockHash")) {
            _expectBytes32("genesis block hash", record.readBytes32(".genesisBlockHash"), observedGenesis);
        } else {
            console.log("WARN legacy record has no genesis-block network binding");
        }
        _verifyPublicPositions(record);
        _verifyProvenance(record, router);
        _verifyRecoveryManager(record, router);
        CompatibilityProfile memory profile =
            _verifiedArtifactProfile(vm.getArtifactPathByCode(type(HyperionRouter).creationCode));
        _verifiedArtifactProfile(vm.getArtifactPathByCode(type(CctpAdapter).creationCode));
        if (vm.keyExistsJson(record, ".axelarAdapter")) {
            _verifiedArtifactProfile(vm.getArtifactPathByCode(type(AxelarItsAdapter).creationCode));
        }
        _expectString("EVM revision", record.readString(".evmVersion"), profile.evmVersion);
        _expectString("compiler revision", record.readString(".solcVersion"), profile.compilerVersion);
        _expectUint("optimizer runs", record.readUint(".optimizerRuns"), profile.optimizerRuns);
        _expectTrue("via IR matches artifact", record.readBool(".viaIR") == profile.viaIR);
        _expectAddress("treasury", router.treasury(), record.readAddress(".treasury"));
        _expectUint("fee bps", router.feeBps(), record.readUint(".feeBps"));
        _expectUint("timelock delay", router.timelockDelay(), record.readUint(".timelockDelay"));
        _expectUint("flow window", router.flowWindow(), record.readUint(".flowWindow"));

        _expectAddress("cctp adapter", router.adapter(RouteKind.Cctp), address(cctp));
        _expectAddress("cctp receiver", router.railReceiver(RouteKind.Cctp), address(cctp));
        _expectTrue("cctp route enabled", router.routeEnabled(RouteKind.Cctp));
        _expectAddress("cctp adapter router", cctp.ROUTER(), address(router));
        _expectAddress(
            "cctp token messenger", address(cctp.TOKEN_MESSENGER()), record.readAddress(".cctpTokenMessenger")
        );

        // The lane is the value a wrong entry costs the most: it decides who Circle credits.
        CctpAdapter.Lane memory lane = cctp.laneOf(record.readString(".stellarChain"));
        _expectTrue("cctp lane configured", lane.configured);
        _expectTrue("cctp lane enabled", lane.enabled);
        _expectUint("cctp lane domain", lane.domain, STELLAR_CCTP_DOMAIN);
        bytes32 recordedRecipient = record.readBytes32(".stellarRailRecipient");
        _expectBytes32("cctp mint recipient", lane.mintRecipient, recordedRecipient);
        _expectBytes32("cctp remote token", lane.remoteToken, record.readBytes32(".stellarCctpToken"));
        _expectUint("cctp mapping revision", lane.mappingRevision, record.readUint(".cctpMappingRevision"));
        _expectUint("cctp local decimals", lane.localDecimals, record.readUint(".cctpLocalDecimals"));
        _expectUint("cctp remote decimals", lane.remoteDecimals, record.readUint(".cctpRemoteDecimals"));

        address token = record.readAddress(".token");
        _expectTrue("token registered", router.tokenConfig(token).registered);
        _expectTrue("token enabled", router.tokenConfig(token).enabled);
        _expectUint("token decimals", router.tokenConfig(token).decimals, record.readUint(".tokenDecimals"));
        _expectUint(
            "token flow limit", router.tokenConfig(token).flowLimit, record.readUint(".tokenFlowLimit")
        );

        _expectFalse("router paused", router.paused());

        _verifyAxelar(record, router, token);
        _verifyAuthority(record, router);

        console.log("");
        if (problems == 0) {
            console.log("Everything on chain matches the record.");
        } else {
            console.log("Mismatches          ", problems);
            revert("the chain and the record disagree");
        }
    }

    /// @dev Public local evidence only. No contract call, RPC, signer or broadcast in this branch.
    function _unsignedPlan() private view {
        requireCompatibleExecutionTarget();
        string memory path = vm.envOr(
            "HYPERION_RECORD", string.concat("deployments/evm-", vm.toString(block.chainid), "-phase1.json")
        );
        string memory record = vm.readFile(path);
        require(record.readUint(".chainId") == block.chainid, "record chain id differs from plan");
        address router = record.readAddress(".router");
        require(
            router != address(0) && record.readAddress(".cctpAdapter") != address(0)
                && record.readAddress(".token") != address(0) && record.readAddress(".admin") != address(0)
                && record.readAddress(".treasury") != address(0)
                && record.readAddress(".deployer") != address(0),
            "record has a zero required address"
        );
        require(record.readUint(".feeBps") <= 100, "record fee exceeds cap");
        require(
            record.readUint(".timelockDelay") >= 1 hours && record.readUint(".timelockDelay") <= 30 days,
            "record timelock outside bounds"
        );
        require(
            record.readUint(".flowWindow") >= 5 minutes && record.readUint(".flowWindow") <= 7 days,
            "record flow window outside bounds"
        );
        require(
            record.readUint(".tokenDecimals") <= 18 && record.readUint(".tokenFlowLimit") != 0,
            "record token configuration outside bounds"
        );
        bytes32 chain = keccak256(bytes(record.readString(".stellarChain")));
        require(
            chain == keccak256(bytes(STELLAR_CHAIN)) || chain == keccak256(bytes(STELLAR_TESTNET_CHAIN)),
            "unknown Stellar peer network"
        );
        require(record.readBytes32(".stellarRailRecipient") != bytes32(0), "record lacks rail recipient");
        CompatibilityProfile memory profile =
            _verifiedArtifactProfile(vm.getArtifactPathByCode(type(HyperionRouter).creationCode));
        require(
            keccak256(bytes(record.readString(".evmVersion"))) == keccak256(bytes(profile.evmVersion))
                && keccak256(bytes(record.readString(".solcVersion")))
                    == keccak256(bytes(profile.compilerVersion))
                && record.readUint(".optimizerRuns") == profile.optimizerRuns
                && record.readBool(".viaIR") == profile.viaIR,
            "record build profile differs from artifact"
        );
        _artifactIdentity("HYPERION_ROUTER_ARTIFACT_HASH", type(HyperionRouter).creationCode);
        _artifactIdentity("HYPERION_CCTP_ARTIFACT_HASH", type(CctpAdapter).creationCode);
        _publicCodeIdentity(record.readAddress(".cctpTokenMessenger"), "CCTP_TOKEN_MESSENGER_CODE_HASH");
        _publicCodeIdentity(
            record.readAddress(".cctpMessageTransmitter"), "CCTP_MESSAGE_TRANSMITTER_CODE_HASH"
        );
        require(
            record.readAddress(".provenanceStore")
                    == address(uint160(uint256(keccak256(abi.encodePacked(hex"d694", router, hex"01")))))
                && record.readBytes32(".provenanceStoreCodeHash") != bytes32(0),
            "record lacks immutable provenance identity"
        );
        require(
            vm.keyExistsJson(record, ".recoveryManager")
                == vm.keyExistsJson(record, ".recoveryManagerCodeHash"),
            "record has incomplete recovery identity"
        );
        if (vm.keyExistsJson(record, ".recoveryManager")) {
            require(
                record.readAddress(".recoveryManager")
                        == address(uint160(uint256(keccak256(abi.encodePacked(hex"d694", router, hex"02")))))
                    && record.readBytes32(".recoveryManagerCodeHash") != bytes32(0),
                "record has invalid recovery identity"
            );
        }
        if (vm.keyExistsJson(record, ".axelarAdapter")) {
            require(record.readAddress(".axelarAdapter") != address(0), "record has zero Axelar adapter");
            _artifactIdentity("HYPERION_AXELAR_ARTIFACT_HASH", type(AxelarItsAdapter).creationCode);
            _publicCodeIdentity(record.readAddress(".axelarIts"), "AXELAR_ITS_CODE_HASH");
            _publicCodeIdentity(record.readAddress(".axelarGasService"), "AXELAR_GAS_SERVICE_CODE_HASH");
            require(record.readBytes32(".axelarTokenId") != bytes32(0), "record lacks Axelar token identity");
            require(vm.envBytes("STELLAR_AXELAR_PEER").length == 32, "Stellar Axelar peer must be 32 bytes");
        }
        console.log("mode                 dry-run");
        console.log("signed               false");
        console.log("submitted            false");
        console.log("record               ", path);
        console.log("router               ", router);
        console.log("chain id             ", block.chainid);
        console.log("planned read         configuration, token, adapters, provider links, immutable code");
        console.log("planned read         admin grants; bounded guardian grant/revoke history from block");
        console.log("history starts       ", record.readUint(".deployedAtBlock"));
        console.log("expected admin       ", record.readAddress(".admin"));
        console.log("expected guardian    ", record.readAddress(".guardian"));
        console.log("public expected record", record);
        console.log("live verification    pending; local identities are reviewed operator inputs");
    }

    function _artifactIdentity(string memory name, bytes memory creationCode) private view {
        bytes32 expected = vm.envOr(name, bytes32(0));
        require(expected != bytes32(0), "missing reviewed artifact identity");
        require(expected == keccak256(creationCode), "artifact differs from reviewed identity");
    }

    function _publicCodeIdentity(address target, string memory name) private view {
        require(
            target != address(0) && vm.envOr(name, bytes32(0)) != bytes32(0),
            "missing reviewed provider identity"
        );
    }

    function _verifyProvenance(string memory record, HyperionRouter router) internal {
        address expected =
            address(uint160(uint256(keccak256(abi.encodePacked(hex"d694", address(router), hex"01")))));
        address recorded = record.readAddress(".provenanceStore");
        _expectAddress("immutable provenance address", recorded, expected);
        _expectTrue("immutable provenance code exists", expected.code.length != 0);
        _expectBytes32(
            "immutable provenance code hash",
            expected.codehash,
            record.readBytes32(".provenanceStoreCodeHash")
        );
        if (expected.code.length != 0) {
            _expectAddress(
                "immutable provenance router", OutboundProvenance(expected).ROUTER(), address(router)
            );
        }
    }

    function _verifyRecoveryManager(string memory record, HyperionRouter router) internal {
        address expected =
            address(uint160(uint256(keccak256(abi.encodePacked(hex"d694", address(router), hex"02")))));
        bool hasAddress = vm.keyExistsJson(record, ".recoveryManager");
        bool hasCodeHash = vm.keyExistsJson(record, ".recoveryManagerCodeHash");
        require(hasAddress == hasCodeHash, "record has incomplete token recovery manager fields");
        if (!hasAddress) {
            require(expected.code.length == 0, "record lacks required token recovery manager");
            console.log("WARN legacy router record has no token recovery manager");
            return;
        }
        address recorded = record.readAddress(".recoveryManager");
        _expectAddress("immutable token recovery manager address", recorded, expected);
        _expectTrue("immutable token recovery manager code exists", expected.code.length != 0);
        _expectBytes32(
            "immutable token recovery manager code hash",
            expected.codehash,
            record.readBytes32(".recoveryManagerCodeHash")
        );
        if (expected.code.length != 0) {
            _expectAddress(
                "immutable token recovery manager router",
                TokenRecoveryManager(expected).ROUTER(),
                address(router)
            );
        }
    }

    function _verifyPublicPositions(string memory record) internal {
        if (!vm.keyExistsJson(record, ".positions.initialization.txHash")) {
            console.log("WARN legacy record has no public initialization transaction position");
            return;
        }
        _verifyReceiptPosition(record, ".positions.initialization");
        uint256 index;
        while (vm.keyExistsJson(
                record, string.concat(".positions.activation[", vm.toString(index), "].txHash")
            )) {
            _verifyReceiptPosition(record, string.concat(".positions.activation[", vm.toString(index), "]"));
            ++index;
        }
        console.log("  ok   initialization receipt");
        console.log("  ok   activation receipts", index);
        if (index == 0) console.log("WARN no activation transaction positions are recorded");
    }

    function _verifyReceiptPosition(string memory record, string memory path) private {
        string memory txHash = record.readString(string.concat(path, ".txHash"));
        string memory transaction =
            vm.rpcJson("eth_getTransactionByHash", string.concat("[\"", txHash, "\"]"));
        string memory receipt = vm.rpcJson("eth_getTransactionReceipt", string.concat("[\"", txHash, "\"]"));
        require(bytes(transaction).length > 2, "recorded transaction is unavailable from public RPC");
        require(bytes(receipt).length > 2, "recorded transaction has no public receipt");
        _expectAddress(
            string.concat(path, " sender"),
            vm.parseJsonAddress(transaction, ".from"),
            record.readAddress(".deployer")
        );
        if (keccak256(bytes(path)) == keccak256(bytes(".positions.initialization"))) {
            _expectAddress(
                string.concat(path, " created router"),
                vm.parseJsonAddress(receipt, ".contractAddress"),
                record.readAddress(".router")
            );
        } else {
            _expectAddress(
                string.concat(path, " target router"),
                vm.parseJsonAddress(transaction, ".to"),
                record.readAddress(".router")
            );
        }
        _expectString(
            string.concat(path, " receipt hash"), vm.parseJsonString(receipt, ".transactionHash"), txHash
        );
        _expectString(string.concat(path, " receipt status"), vm.parseJsonString(receipt, ".status"), "0x1");
        _expectString(
            string.concat(path, " receipt block"),
            vm.parseJsonString(receipt, ".blockHash"),
            record.readString(string.concat(path, ".blockHash"))
        );
        _expectString(
            string.concat(path, " block number"),
            vm.toString(_hexQuantity(vm.parseJsonString(receipt, ".blockNumber"))),
            record.readString(string.concat(path, ".blockNumber"))
        );
    }

    function _hexQuantity(string memory encoded) private pure returns (uint256 value) {
        bytes memory raw = bytes(encoded);
        require(raw.length >= 3 && raw[0] == "0" && (raw[1] == "x" || raw[1] == "X"), "invalid RPC quantity");
        for (uint256 i = 2; i < raw.length; ++i) {
            uint8 digit = uint8(raw[i]);
            if (digit >= 48 && digit <= 57) digit -= 48;
            else if (digit >= 65 && digit <= 70) digit = digit - 65 + 10;
            else if (digit >= 97 && digit <= 102) digit = digit - 97 + 10;
            else revert("invalid RPC quantity");
            value = value * 16 + digit;
        }
    }

    function _verifyAxelar(string memory record, HyperionRouter router, address token) private {
        if (vm.keyExistsJson(record, ".axelarAdapter")) {
            AxelarItsAdapter axelar = AxelarItsAdapter(payable(record.readAddress(".axelarAdapter")));
            _expectAddress("axelar adapter", router.adapter(RouteKind.AxelarIts), address(axelar));
            _expectAddress("axelar receiver", router.railReceiver(RouteKind.AxelarIts), address(axelar));
            _expectTrue("axelar route enabled", router.routeEnabled(RouteKind.AxelarIts));
            _expectAddress("axelar adapter router", axelar.ROUTER(), address(router));
            _expectBytes32("axelar token id", axelar.tokenIdOf(token), record.readBytes32(".axelarTokenId"));

            AxelarItsAdapter.Peer memory peer = axelar.peerOf(record.readString(".stellarChain"));
            _expectTrue("axelar peer configured", peer.configured);
            _expectTrue("axelar peer enabled", peer.enabled);
            _expectBytes("axelar peer address", peer.peer, vm.envBytes("STELLAR_AXELAR_PEER"));
        }
    }

    function _verifyAuthority(string memory record, HyperionRouter router) private {
        // The admin handover is the one thing that cannot be checked by equality alone, because a
        // record written before the handover matured names the deployer.
        address recordedAdmin = record.readAddress(".admin");
        bool adminHolds = router.hasRole(router.DEFAULT_ADMIN_ROLE(), recordedAdmin);
        console.log(
            adminHolds
                ? "  ok   admin role held by the recorded admin"
                : "  WARN admin role not yet handed over"
        );
        if (!adminHolds) {
            problems += 1;
            console.log("       recorded admin    ", recordedAdmin);
            console.log("       deployer          ", record.readAddress(".deployer"));
            console.log("       authority policy is not satisfied");
        }

        address recordedGuardian = record.readAddress(".guardian");
        if (recordedGuardian == address(0)) {
            // AccessControl is not enumerable. A zero address alone cannot prove absence of other
            // guardians: reconstruct every grant/revoke from before deployment and fail closed
            // when history is unavailable, truncated or exceeds the bounded read window.
            _expectFalse(
                "zero address has guardian authority", router.hasRole(router.GUARDIAN_ROLE(), address(0))
            );
            _expectUint(
                "active guardians under disabled policy",
                _activeGuardianCount(router, record.readUint(".deployedAtBlock")),
                0
            );
        } else {
            _expectTrue("recorded guardian role", router.hasRole(router.GUARDIAN_ROLE(), recordedGuardian));
        }
    }

    function _activeGuardianCount(HyperionRouter router, uint256 fromBlock) private returns (uint256) {
        require(
            fromBlock <= block.number && block.number - fromBlock <= 262_144,
            "guardian history exceeds bounded verification window"
        );
        if (fromBlock > 0) {
            string memory prior = vm.rpcJson(
                "eth_getCode",
                string.concat("[\"", vm.toString(address(router)), "\",\"", _quantity(fromBlock - 1), "\"]")
            );
            require(
                keccak256(bytes(vm.parseJsonString(prior, "$"))) == keccak256(bytes("0x")),
                "guardian history starts after deployment"
            );
        }
        address[] memory members = new address[](128);
        bool[] memory active = new bool[](128);
        uint256 used;
        uint256 count;
        bytes32 granted = keccak256("RoleGranted(bytes32,address,address)");
        bytes32 revoked = keccak256("RoleRevoked(bytes32,address,address)");
        for (uint256 first = fromBlock; first <= block.number;) {
            uint256 last = first + 4095;
            if (last > block.number) last = block.number;
            string memory filter = string.concat(
                "[{\"address\":\"",
                vm.toString(address(router)),
                "\",\"fromBlock\":\"",
                _quantity(first),
                "\",\"toBlock\":\"",
                _quantity(last),
                "\",\"topics\":[[\"",
                vm.toString(granted),
                "\",\"",
                vm.toString(revoked),
                "\"],\"",
                vm.toString(router.GUARDIAN_ROLE()),
                "\"]}]"
            );
            string memory logs = vm.rpcJson("eth_getLogs", filter);
            (used, count) = _applyGuardianLogs(
                logs, address(router), router.GUARDIAN_ROLE(), members, active, used, count
            );
            if (last == block.number) break;
            first = last + 1;
        }
        for (uint256 i; i < used; ++i) {
            require(
                router.hasRole(router.GUARDIAN_ROLE(), members[i]) == active[i],
                "guardian history and live roles disagree"
            );
        }
        return count;
    }

    /// @dev Validate complete RPC arrays and apply each guardian event in canonical RPC order.
    function _applyGuardianLogs(
        string memory logs,
        address router,
        bytes32 role,
        address[] memory members,
        bool[] memory active,
        uint256 used,
        uint256 count
    ) internal view returns (uint256, uint256) {
        bytes memory raw = bytes(logs);
        require(
            raw.length >= 2 && raw.length <= 1_048_576 && raw[0] == "[" && raw[raw.length - 1] == "]",
            "guardian RPC did not return a complete bounded array"
        );
        uint256 index;
        while (vm.keyExistsJson(logs, string.concat("$[", vm.toString(index), "]"))) {
            require(index < 1024, "guardian event page exceeds 1024 entries");
            string memory key = string.concat("$[", vm.toString(index), "]");
            bytes32[] memory topics = vm.parseJsonBytes32Array(logs, string.concat(key, ".topics"));
            require(
                vm.parseJsonAddress(logs, string.concat(key, ".address")) == router && topics.length == 4
                    && topics[1] == role,
                "guardian event identity differs"
            );
            require(
                !vm.parseJsonBool(logs, string.concat(key, ".removed")),
                "removed guardian event is not canonical evidence"
            );
            require(
                vm.parseJsonBytes(logs, string.concat(key, ".data")).length == 0,
                "unexpected guardian event data"
            );
            bool grant = topics[0] == keccak256("RoleGranted(bytes32,address,address)");
            require(
                grant || topics[0] == keccak256("RoleRevoked(bytes32,address,address)"),
                "unexpected guardian event kind"
            );
            require(uint256(topics[2]) >> 160 == 0, "guardian address padding is invalid");
            address member = address(uint160(uint256(topics[2])));
            uint256 position;
            while (position < used && members[position] != member) ++position;
            if (position == used) {
                require(used < members.length, "guardian membership exceeds verification bound");
                members[used++] = member;
            }
            if (grant && !active[position]) {
                active[position] = true;
                ++count;
            } else if (!grant && active[position]) {
                active[position] = false;
                --count;
            }
            ++index;
        }
        return (used, count);
    }

    function _quantity(uint256 number) private pure returns (string memory) {
        bytes16 digits = "0123456789abcdef";
        bytes memory encoded = new bytes(64);
        uint256 length;
        do {
            encoded[63 - length++] = digits[number & 15];
            number >>= 4;
        } while (number != 0);
        bytes memory output = new bytes(length + 2);
        output[0] = "0";
        output[1] = "x";
        for (uint256 i; i < length; ++i) {
            output[i + 2] = encoded[64 - length + i];
        }
        return string(output);
    }

    function _expectAddress(string memory what, address found, address want) private {
        if (found == want) {
            console.log("  ok  ", what, found);
        } else {
            problems += 1;
            console.log("  BAD ", what);
            console.log("        found", found);
            console.log("        want ", want);
        }
    }

    function _expectUint(string memory what, uint256 found, uint256 want) private {
        if (found == want) {
            console.log("  ok  ", what, found);
        } else {
            problems += 1;
            console.log("  BAD ", what);
            console.log("        found", found);
            console.log("        want ", want);
        }
    }

    function _expectBytes32(string memory what, bytes32 found, bytes32 want) private {
        if (found == want) {
            console.log("  ok  ", what);
        } else {
            problems += 1;
            console.log("  BAD ", what);
            console.log("        found", vm.toString(found));
            console.log("        want ", vm.toString(want));
        }
    }

    function _expectBytes(string memory what, bytes memory found, bytes memory want) private {
        if (keccak256(found) == keccak256(want)) {
            console.log("  ok  ", what);
        } else {
            problems += 1;
            console.log("  BAD ", what);
            console.log("        found", vm.toString(found));
            console.log("        want ", vm.toString(want));
        }
    }

    function _expectString(string memory what, string memory found, string memory want) private {
        if (keccak256(bytes(found)) == keccak256(bytes(want))) {
            console.log("  ok  ", what, found);
        } else {
            problems += 1;
            console.log("  BAD ", what);
            console.log("        found", found);
            console.log("        want ", want);
        }
    }

    function _expectTrue(string memory what, bool found) private {
        if (found) {
            console.log("  ok  ", what);
        } else {
            problems += 1;
            console.log("  BAD ", what, "is false and should be true");
        }
    }

    function _expectFalse(string memory what, bool found) private {
        if (!found) {
            console.log("  ok  ", what, "is false");
        } else {
            problems += 1;
            console.log("  BAD ", what, "is true and should be false");
        }
    }
}
