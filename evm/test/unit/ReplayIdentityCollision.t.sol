// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReplayedMessage} from "../../src/HyperionErrors.sol";
import {RouteKind} from "../../src/HyperionTypes.sol";
import {Fixture} from "../Fixture.sol";

contract ReplayIdentityCollisionTest is Fixture {
    bytes32 internal constant ID_A = 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa000000000000002a;
    bytes32 internal constant ID_B = 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab000000000000002a;
    bytes32 internal constant ID_C = 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaac000000000000002a;
    uint256 internal constant DELIVERY = 1e6;

    function test_distinct_full_width_ids_sharing_prefix_and_display_nonce_do_not_collide() public {
        usdc.mint(railReceiver, DELIVERY * 4);
        vm.prank(railReceiver);
        usdc.approve(address(router), type(uint256).max);

        bytes32[3] memory ids = [ID_A, ID_B, ID_C];
        vm.startPrank(railReceiver);
        for (uint256 i; i < ids.length; ++i) {
            assertEq(uint64(uint256(ids[i])), 42, "same displayed nonce");
            router.bridgeIn(RouteKind.Cctp, address(usdc), DELIVERY, bob, _replayOrigin(ids[i], 42));
            assertTrue(router.processed(keccak256(abi.encode(RouteKind.Cctp, ids[i]))));
        }
        vm.expectRevert(ReplayedMessage.selector);
        router.bridgeIn(RouteKind.Cctp, address(usdc), DELIVERY, bob, _replayOrigin(ID_B, 42));
        vm.stopPrank();

        assertEq(usdc.balanceOf(bob), DELIVERY * 3);
    }
}
