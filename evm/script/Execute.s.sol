// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {stdJson} from "forge-std/StdJson.sol";
import {console} from "forge-std/console.sol";

import {HyperionRouter} from "../src/HyperionRouter.sol";
import {ActionKind, QueuedAction, RouteKind, TokenConfig} from "../src/HyperionTypes.sol";
import {AxelarItsAdapter} from "../src/adapters/AxelarItsAdapter.sol";
import {CctpAdapter} from "../src/adapters/CctpAdapter.sol";

import {IERC20Metadata} from "openzeppelin/token/ERC20/extensions/IERC20Metadata.sol";

import {DeployConfig} from "./DeployConfig.sol";

/// @title Phase two: execute what phase one queued, once it has matured
/// @author dotmantissa
/// @notice Reads the record phase one wrote, walks the queued actions in the order they were
/// queued, and executes the ones that are ready. Reports the ones that are not and stops rather
/// than skipping them, because these actions depend on each other: enabling a route before its
/// adapter is set leaves a rail that is on and unreachable.
///
/// Safe to run more than once. An action already executed is skipped with a note rather than
/// retried, so running this after a partial failure picks up where it left off. That matters
/// because the thing most likely to interrupt a run is a gas spike, and the recovery should not
/// require anybody to work out by hand which of nine actions landed.
///
/// Usage:
///   forge script script/Execute.s.sol --rpc-url $RPC --broadcast
contract Execute is DeployConfig {
    using stdJson for string;

    function run() external {
        string memory path = vm.envOr(
            "HYPERION_RECORD", string.concat("deployments/evm-", vm.toString(block.chainid), "-phase1.json")
        );
        string memory record = vm.readFile(path);

        address routerAddress = record.readAddress(".router");
        uint256[] memory ids = record.readUintArray(".queuedActionIds");
        string[] memory whats = record.readStringArray(".queuedActions");

        require(record.readUint(".chainId") == block.chainid, "record chain id differs from RPC");
        require(
            vm.keyExistsJson(record, ".genesisBlockHash")
                && record.readBytes32(".genesisBlockHash") == observedGenesisBlockHash(),
            "record genesis block differs from RPC; legacy records require reviewed rebinding"
        );
        require(routerAddress.code.length != 0, "record router has no code");
        require(ids.length > 0 && ids.length <= 64, "invalid deployment action count");
        for (uint256 i; i < ids.length; ++i) {
            require(ids[i] > 0 && ids[i] <= type(uint64).max, "action id exceeds uint64");
        }
        HyperionRouter router = HyperionRouter(payable(routerAddress));

        console.log("record              ", path);
        console.log("router              ", routerAddress);
        console.log("actions             ", ids.length);
        console.log("now                 ", block.timestamp);
        console.log("");

        if (vm.envOr("HYPERION_REPORT_ONLY", false)) {
            _reportPending(router, ids, whats);
            return;
        }
        _preflightProviders(router, record);

        uint256 executed;
        uint256 alreadyDone;

        for (uint256 i = 0; i < ids.length; ++i) {
            uint64 id = uint64(ids[i]);
            string memory what = i < whats.length ? whats[i] : "unnamed";
            QueuedAction memory action = router.queuedAction(id);

            if (action.id == 0) {
                // Cancelled, or a record pointing at a different router. Either way, stopping is
                // the only honest move: carrying on would configure half a router from a list
                // that does not describe it.
                console.log("MISSING", id, what);
                revert("queued action is not on this router; wrong record or it was cancelled");
            }
            if (action.executed) {
                console.log("done already", id, what);
                alreadyDone += 1;
                continue;
            }
            if (block.timestamp < action.eta) {
                console.log("NOT READY", id, what);
                console.log("  ready at          ", action.eta);
                console.log("  seconds remaining ", action.eta - block.timestamp);
                revert("timelock has not matured; wait and run again");
            }
            if (block.timestamp > action.expiresAt) {
                console.log("EXPIRED", id, what);
                console.log("  expired at        ", action.expiresAt);
                revert("queued action expired; requeue it before executing");
            }

            if (action.action.kind == ActionKind.EnableRoute && action.action.amount != 0) {
                _preflightActivation(router, action.action.route, record);
            }
            vm.startBroadcast();
            router.executeAction(id);
            vm.stopBroadcast();
            executed += 1;
            console.log("executed", id, what);
        }
        console.log("");
        console.log("executed this run   ", executed);
        console.log("already done        ", alreadyDone);

        _verify(router, record);
    }

    /// @notice Deterministic read-only schedule report. It never starts a broadcast or changes
    /// state, and it uses the router's current timestamps rather than the deployment record's
    /// planned times.
    function _reportPending(HyperionRouter router, uint256[] memory ids, string[] memory whats) private view {
        for (uint256 i = 0; i < ids.length; ++i) {
            uint64 id = uint64(ids[i]);
            string memory what = i < whats.length ? whats[i] : "unnamed";
            QueuedAction memory action = router.queuedAction(id);
            if (action.id == 0) {
                console.log("EXCLUDED missing-or-cancelled", id, what);
            } else if (action.executed) {
                console.log("EXCLUDED executed", id, what);
            } else if (block.timestamp > action.expiresAt) {
                console.log("EXCLUDED expired", id, what);
                console.log("  expired at        ", action.expiresAt);
            } else if (block.timestamp < action.eta) {
                console.log("PENDING", id, what);
                console.log("  ready at          ", action.eta);
                console.log("  seconds remaining ", action.eta - block.timestamp);
                console.log("  expires at        ", action.expiresAt);
            } else {
                console.log("READY", id, what);
                console.log("  expires at        ", action.expiresAt);
            }
        }
    }

    /// @dev Validate phase-one provider intent before signing without demanding queued router
    /// prerequisites. Token registration and pointer equality are checked at EnableRoute.
    function _preflightProviders(HyperionRouter router, string memory record) private view {
        address token = record.readAddress(".token");
        require(token.code.length != 0, "record token has no code");
        require(
            IERC20Metadata(token).decimals() == record.readUint(".tokenDecimals"), "token precision changed"
        );
        string memory chain = record.readString(".stellarChain");
        CctpAdapter cctp = CctpAdapter(payable(record.readAddress(".cctpAdapter")));
        require(address(cctp).code.length != 0, "record CCTP adapter has no code");
        require(
            cctp.ROUTER() == address(router) && cctp.route() == RouteKind.Cctp, "CCTP router or route differs"
        );
        require(cctp.USDC() == token, "CCTP token mapping changed");
        require(
            address(cctp.TOKEN_MESSENGER()) == record.readAddress(".cctpTokenMessenger"),
            "CCTP messenger differs"
        );
        CctpAdapter.Lane memory lane = cctp.laneOf(chain);
        require(
            lane.configured && lane.enabled && lane.domain == STELLAR_CCTP_DOMAIN,
            "CCTP destination lane is unavailable"
        );
        require(lane.mintRecipient == record.readBytes32(".stellarRailRecipient"), "CCTP recipient differs");
        require(lane.remoteToken == record.readBytes32(".stellarCctpToken"), "CCTP token differs");
        require(lane.mappingRevision == record.readUint(".cctpMappingRevision"), "CCTP revision differs");
        require(lane.localDecimals == record.readUint(".cctpLocalDecimals"), "CCTP local decimals differ");
        require(lane.remoteDecimals == record.readUint(".cctpRemoteDecimals"), "CCTP remote decimals differ");
        if (vm.keyExistsJson(record, ".axelarAdapter")) {
            AxelarItsAdapter axelar = AxelarItsAdapter(payable(record.readAddress(".axelarAdapter")));
            require(address(axelar).code.length != 0, "record Axelar adapter has no code");
            require(
                axelar.ROUTER() == address(router) && axelar.route() == RouteKind.AxelarIts,
                "Axelar router or route differs"
            );
            require(address(axelar.ITS()) == record.readAddress(".axelarIts"), "Axelar ITS differs");
            require(
                address(axelar.GAS_SERVICE()) == record.readAddress(".axelarGasService"),
                "Axelar gas service differs"
            );
            require(
                axelar.tokenIdOf(token) == record.readBytes32(".axelarTokenId"),
                "Axelar token mapping differs"
            );
            AxelarItsAdapter.Peer memory peer = axelar.peerOf(chain);
            require(peer.configured && peer.enabled, "Axelar destination peer is unavailable");
            require(
                keccak256(bytes(peer.axelarChain))
                    == keccak256(bytes(record.readString(".axelarStellarChain"))),
                "Axelar chain name differs"
            );
            require(keccak256(peer.peer) == keccak256(stellarAxelarPeer()), "Axelar peer address differs");
        }
    }

    function _preflightActivation(HyperionRouter router, RouteKind route, string memory json) private view {
        _preflightProviders(router, json);
        address token = json.readAddress(".token");
        TokenConfig memory config = router.tokenConfig(token);
        require(config.registered && config.enabled, "queued token registration has not completed");
        require(config.decimals == json.readUint(".tokenDecimals"), "registered token precision differs");
        require(config.flowLimit == json.readUint(".tokenFlowLimit"), "registered token flow limit differs");
        address adapterAddress;
        if (route == RouteKind.Cctp) {
            adapterAddress = json.readAddress(".cctpAdapter");
        } else if (route == RouteKind.AxelarIts && vm.keyExistsJson(json, ".axelarAdapter")) {
            adapterAddress = json.readAddress(".axelarAdapter");
        } else {
            revert("record does not name this activation route");
        }
        require(router.adapter(route) == adapterAddress, "queued adapter configuration has not completed");
        require(
            router.railReceiver(route) == adapterAddress, "queued receiver configuration has not completed"
        );
    }

    /// @dev Read the router back rather than trusting that the transactions above did what they
    /// said. The actions were validated on the way in and again on the way out, so this is not
    /// looking for a contract bug; it is looking for a record that described a different router,
    /// or a run that somebody interrupted and restarted against the wrong file.
    function _verify(HyperionRouter router, string memory record) private view {
        address token = record.readAddress(".token");

        console.log("");
        console.log("Reading the router back:");
        console.log("  treasury          ", router.treasury());
        console.log("  fee bps           ", router.feeBps());
        console.log("  paused            ", router.paused());
        console.log("  cctp adapter      ", router.adapter(RouteKind.Cctp));
        console.log("  cctp receiver     ", router.railReceiver(RouteKind.Cctp));
        console.log("  cctp enabled      ", router.routeEnabled(RouteKind.Cctp));

        if (vm.keyExistsJson(record, ".axelarAdapter")) {
            console.log("  axelar adapter    ", router.adapter(RouteKind.AxelarIts));
            console.log("  axelar receiver   ", router.railReceiver(RouteKind.AxelarIts));
            console.log("  axelar enabled    ", router.routeEnabled(RouteKind.AxelarIts));
        }

        console.log("  token registered  ", router.tokenConfig(token).registered);
        console.log("  token enabled     ", router.tokenConfig(token).enabled);
        console.log("  token decimals    ", router.tokenConfig(token).decimals);
        console.log("  token flow limit  ", router.tokenConfig(token).flowLimit);
        (uint256 breakerThreshold, bool breakerTripped) = router.circuitBreaker(token);
        console.log("  breaker threshold ", breakerThreshold);
        console.log("  breaker tripped   ", breakerTripped);
        console.log("  flow available    ", router.flowAvailable(token, RouteKind.Cctp));

        bool live = router.routeEnabled(RouteKind.Cctp) && router.tokenConfig(token).enabled
            && router.adapter(RouteKind.Cctp) != address(0) && !router.paused();
        console.log("");
        console.log(live ? "CCTP is routable." : "CCTP is NOT routable. Something above is wrong.");
    }
}
