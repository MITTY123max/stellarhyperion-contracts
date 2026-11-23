//! What this adapter stores.

use soroban_sdk::{contracttype, Address, BytesN, String, U256};

/// Set once at `initialize` and afterwards only the admin moves.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    /// Holds the admin powers. In production this is the router's timelocked multisig.
    pub admin: Address,
    /// The only address allowed to ask for a dispatch.
    pub router: Address,
    /// Allbridge Core's bridge contract.
    pub bridge: Address,
    /// The wrapped native asset, which is what Allbridge charges relaying in.
    ///
    /// The bridge knows its own native token but does not expose it, so it is passed in and
    /// checked the first time a transfer needs it.
    pub native: Address,
}

/// One lane: Hyperion's name for a chain paired with Allbridge's number for it.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChainLane {
    pub chain: String,
    pub allbridge_chain_id: u32,
}

/// One asset on one lane, and the token it turns into at the far end.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssetLink {
    pub token: Address,
    pub allbridge_chain_id: u32,
    /// The destination token's address, left padded to thirty two bytes.
    pub receive_token: BytesN<32>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ValidatorEpoch {
    pub epoch: u32,
    pub validator: BytesN<32>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingValidator {
    pub epoch: u32,
    pub validator: BytesN<32>,
    pub activate_after: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OutboundRecord {
    pub nonce: u64,
    pub token: Address,
    pub amount: i128,
    pub destination_chain: String,
    pub destination: BytesN<32>,
    pub receive_token: BytesN<32>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderStatus {
    Unknown,
    Submitted,
    Failed,
    Unsupported,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecoveryDecision {
    pub nonce: u64,
    pub retry_allowed: bool,
    /// Provider-backed refund or retry is not implemented.
    pub recovery_supported: bool,
    /// The post-pool provider wire digest cannot be derived from source amounts alone.
    pub provider_identity_available: bool,
    pub reason: u32,
    pub record: OutboundRecord,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InboundIntent {
    pub token: Address,
    pub amount: i128,
    pub recipient: Address,
    pub source_chain_id: u32,
    pub nonce: U256,
    pub signature: BytesN<64>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InboundProviderEvidence {
    pub amount: u128,
    pub recipient: BytesN<32>,
    pub source_chain_id: u32,
    pub destination_chain_id: u32,
    pub receive_token: BytesN<32>,
    pub nonce: U256,
    pub message_id: BytesN<32>,
}

/// Optional provider evidence encoded as a contract enum, avoiding the SDK's
/// environment-free XDR conversion for `Option` of a custom contract type.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
#[allow(clippy::large_enum_variant)] // Contract wire values cannot contain Box indirection.
pub enum ProviderEvidence {
    Missing,
    Present(InboundProviderEvidence),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InboundAuditRequest {
    pub intent: InboundIntent,
    pub provider_evidence: ProviderEvidence,
    pub claim_id: Option<u64>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InboundAuditReport {
    pub message_id: BytesN<32>,
    pub signature_valid: bool,
    pub provider_evidence_present: bool,
    pub provider_matches_intent: bool,
    pub payout_record_present: bool,
    pub payout_provenance_present: bool,
    pub payout_matches_intent: bool,
    pub payout_settled: bool,
    pub verified: bool,
    pub unresolved_trust_assumption: bool,
}

#[cfg(test)]
mod evidence_encoding {
    use super::*;
    use soroban_sdk::{Env, IntoVal, TryFromVal, Val};

    #[test]
    fn optional_provider_evidence_round_trips_contract_values() {
        let env = Env::default();
        let present = ProviderEvidence::Present(InboundProviderEvidence {
            amount: 42,
            recipient: BytesN::from_array(&env, &[1; 32]),
            source_chain_id: 2,
            destination_chain_id: 7,
            receive_token: BytesN::from_array(&env, &[3; 32]),
            nonce: U256::from_u32(&env, 9),
            message_id: BytesN::from_array(&env, &[4; 32]),
        });
        for evidence in [ProviderEvidence::Missing, present] {
            let encoded: Val = evidence.clone().into_val(&env);
            assert_eq!(
                ProviderEvidence::try_from_val(&env, &encoded).unwrap(),
                evidence
            );
        }
    }
}
