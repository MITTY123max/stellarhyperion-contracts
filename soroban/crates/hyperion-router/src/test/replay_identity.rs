extern crate std;

use std::vec::Vec;

use hyperion_core::{AddressKind, HyperionError, RouteKind};
use soroban_sdk::{BytesN, String};

use super::{
    doubles::Delivery,
    setup::{World, HUNDRED},
};

const CORPUS: &str = include_str!("../../../../../testdata/replay-identity-collision-corpus.tsv");

fn vectors(env: &soroban_sdk::Env) -> Vec<(String, BytesN<32>, u64)> {
    CORPUS
        .lines()
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(|line| {
            let mut fields = line.split('|');
            let name = fields.next().unwrap();
            let route = fields.next().unwrap();
            let id = fields.next().unwrap();
            let nonce = fields.next().unwrap().parse::<u64>().unwrap();
            assert_eq!(route, "cctp");
            let hex = id.strip_prefix("0x").unwrap();
            assert_eq!(hex.len(), 64);
            let mut bytes = [0u8; 32];
            for (index, pair) in hex.as_bytes().chunks_exact(2).enumerate() {
                bytes[index] = u8::from_str_radix(core::str::from_utf8(pair).unwrap(), 16).unwrap();
            }
            (
                String::from_str(env, name),
                BytesN::from_array(env, &bytes),
                nonce,
            )
        })
        .collect()
}

#[test]
fn full_width_provider_ids_with_the_same_display_nonce_remain_distinct() {
    let world = World::new();
    let vectors = vectors(&world.env);
    assert!(vectors.len() >= 2);

    let first = vectors[0].1.to_array();
    let first_prefix = &first[..8];
    let first_nonce = &first[24..];
    for (name, id, display_nonce) in &vectors {
        let bytes = id.to_array();
        assert_eq!(&bytes[..8], first_prefix, "{name}");
        assert_eq!(&bytes[24..], first_nonce, "{name}");
        assert_eq!(
            u64::from_be_bytes(bytes[24..].try_into().unwrap()),
            *display_nonce
        );
    }

    world.fund_rail(HUNDRED * vectors.len() as i128);
    for (_, id, source_nonce) in &vectors {
        world.rail().deliver_with_message_id(
            &Delivery {
                route: RouteKind::Cctp,
                token: world.token_id.clone(),
                amount: HUNDRED,
                recipient: world.recipient.clone(),
                recipient_kind: AddressKind::Account,
                source_chain: world.ethereum(),
                source_nonce: *source_nonce,
            },
            id,
        );
        assert!(world.router().was_processed(&RouteKind::Cctp, id));
    }

    let (_, replay_id, source_nonce) = &vectors[0];
    assert_eq!(
        world.rail().try_deliver_with_message_id(
            &Delivery {
                route: RouteKind::Cctp,
                token: world.token_id.clone(),
                amount: HUNDRED,
                recipient: world.recipient.clone(),
                recipient_kind: AddressKind::Account,
                source_chain: world.ethereum(),
                source_nonce: *source_nonce,
            },
            replay_id,
        ),
        Err(Ok(HyperionError::ReplayedMessage))
    );
}
