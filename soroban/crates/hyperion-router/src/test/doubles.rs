//! Test doubles for the pieces of the world the router talks to but does not own.
//!
//! Two of these exist because the real thing cannot produce the failure we need to test. A
//! Stellar Asset Contract registered in the test environment creates trustlines on demand, so
//! it can never refuse a transfer, which makes the parked-claim path unreachable with real
//! assets. And a real rail cannot be summoned into a unit test at all, so `MockRail` stands in
//! for the adapter on the way out and the rail's own receiver on the way in.

use hyperion_core::{AddressKind, HyperionError, RouteKind};
use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contracterror, contractimpl, contracttype, vec, Address, Bytes, BytesN, Env, IntoVal,
    String, Symbol,
};

use crate::types::{Origin, Recipient};
use crate::HyperionRouterClient;

// ------------------------------------------------------------------------------------------
// MockRail
// ------------------------------------------------------------------------------------------

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DispatchRecord {
    pub caller: Address,
    pub token: Address,
    pub amount: i128,
    pub destination_chain: String,
    pub destination: BytesN<32>,
    pub nonce: u64,
}

#[contracttype]
#[derive(Clone)]
enum RailKey {
    Router,
    Last,
    Count,
    FailDispatch,
    FailInbound,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum RailError {
    NotRouter = 1,
    NoDispatch = 2,
    Injected = 3,
}

/// One inbound message, in the shape a rail adapter hands it over.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Delivery {
    pub route: RouteKind,
    pub token: Address,
    pub amount: i128,
    pub recipient: Address,
    pub recipient_kind: AddressKind,
    pub source_chain: String,
    pub source_nonce: u64,
}

/// Stands in for both halves of a rail integration.
///
/// On the way out the router pushes funds here and calls `dispatch`, which is the moment the
/// real adapter would hand them to Circle or Axelar. On the way in this contract plays the
/// rail's receiver: it pre-authorises the router to pull the funds back out of it and then calls
/// `bridge_in`, which is exactly the shape the production adapters use.
#[contract]
pub struct MockRail;

#[contractimpl]
impl MockRail {
    pub fn init(env: Env, router: Address) {
        env.storage().instance().set(&RailKey::Router, &router);
    }

    pub fn set_faults(env: Env, dispatch: bool, inbound: bool) {
        env.storage()
            .instance()
            .set(&RailKey::FailDispatch, &dispatch);
        env.storage()
            .instance()
            .set(&RailKey::FailInbound, &inbound);
    }

    pub fn dispatch(
        env: Env,
        caller: Address,
        token: Address,
        amount: i128,
        destination_chain: String,
        destination: BytesN<32>,
        nonce: u64,
    ) -> Result<(), RailError> {
        caller.require_auth();
        let router: Address = env.storage().instance().get(&RailKey::Router).unwrap();
        if caller != router {
            return Err(RailError::NotRouter);
        }
        if env
            .storage()
            .instance()
            .get(&RailKey::FailDispatch)
            .unwrap_or(false)
        {
            return Err(RailError::Injected);
        }
        let record = DispatchRecord {
            caller,
            token,
            amount,
            destination_chain,
            destination,
            nonce,
        };
        env.storage().instance().set(&RailKey::Last, &record);
        let count: u32 = env.storage().instance().get(&RailKey::Count).unwrap_or(0);
        env.storage().instance().set(&RailKey::Count, &(count + 1));
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn check_dispatch_revision(
        _env: Env,
        _caller: Address,
        _token: Address,
        _amount: i128,
        _destination_chain: String,
        _destination: BytesN<32>,
        _mapping_revision: u32,
        _destination_decimals: u32,
        _gas_amount: Option<i128>,
    ) {
    }

    #[allow(clippy::too_many_arguments)]
    pub fn dispatch_revision(
        env: Env,
        caller: Address,
        token: Address,
        amount: i128,
        destination_chain: String,
        destination: BytesN<32>,
        _mapping_revision: u32,
        _destination_decimals: u32,
        nonce: u64,
    ) -> Result<(), RailError> {
        Self::dispatch(
            env,
            caller,
            token,
            amount,
            destination_chain,
            destination,
            nonce,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn dispatch_from_revision(
        env: Env,
        caller: Address,
        _sender: Address,
        token: Address,
        amount: i128,
        destination_chain: String,
        destination: BytesN<32>,
        nonce: u64,
        _mapping_revision: u32,
        _destination_decimals: u32,
        _gas_amount: i128,
    ) -> Result<(), RailError> {
        Self::dispatch(
            env,
            caller,
            token,
            amount,
            destination_chain,
            destination,
            nonce,
        )
    }

    /// Play the rail's receiver: authorise the pull, then hand the delivery to the router.
    ///
    /// The router's error is passed straight back out rather than aborting, so a test can name
    /// the refusal it expects instead of squinting at a generic panic.
    pub fn deliver(env: Env, delivery: Delivery) -> Result<u64, HyperionError> {
        let id = message_id(&env, delivery.source_nonce);
        deliver_inner(env, delivery, id)
    }

    /// Deliver with an exact provider ID, including any leading zeroes, for replay-collision tests.
    pub fn deliver_with_message_id(
        env: Env,
        delivery: Delivery,
        message_id: BytesN<32>,
    ) -> Result<u64, HyperionError> {
        deliver_inner(env, delivery, message_id)
    }

    pub fn last_dispatch(env: Env) -> Result<DispatchRecord, RailError> {
        env.storage()
            .instance()
            .get(&RailKey::Last)
            .ok_or(RailError::NoDispatch)
    }

    pub fn dispatch_count(env: Env) -> u32 {
        env.storage().instance().get(&RailKey::Count).unwrap_or(0)
    }
}

fn deliver_inner(
    env: Env,
    delivery: Delivery,
    provider_id: BytesN<32>,
) -> Result<u64, HyperionError> {
    let Delivery {
        route,
        token,
        amount,
        recipient,
        recipient_kind,
        source_chain,
        source_nonce,
    } = delivery;
    let router: Address = env.storage().instance().get(&RailKey::Router).unwrap();
    let this = env.current_contract_address();

    // The router pulls rather than trusts, so the receiver has to say in advance that it is
    // good for the amount. This is the documented way for one contract to authorise a
    // transfer that a different contract will actually invoke, and it is not covered by
    // `mock_all_auths`, which only ever stands in for root level signatures.
    env.authorize_as_current_contract(vec![
        &env,
        InvokerContractAuthEntry::Contract(SubContractInvocation {
            context: ContractContext {
                contract: token.clone(),
                fn_name: Symbol::new(&env, "transfer"),
                args: (this.clone(), router.clone(), amount).into_val(&env),
            },
            sub_invocations: vec![&env],
        }),
    ]);

    let outcome = HyperionRouterClient::new(&env, &router).try_bridge_in(
        &this,
        &route,
        &token,
        &amount,
        &Recipient {
            address: recipient,
            kind: recipient_kind,
            raw: Bytes::new(&env),
        },
        &Origin {
            chain: source_chain,
            nonce: source_nonce,
            message_id: provider_id,
            sender: BytesN::from_array(&env, &[7u8; 32]),
        },
    );

    match outcome {
        Ok(Ok(claim_id)) => {
            // Fault after the nested payout/replay writes proves the whole provider
            // invocation rolls back atomically, rather than only refusing before work.
            if env
                .storage()
                .instance()
                .get(&RailKey::FailInbound)
                .unwrap_or(false)
            {
                env.panic_with_error(HyperionError::InvalidLimit);
            }
            Ok(claim_id)
        }
        Err(Ok(err)) => Err(err),
        // Anything else means the router did not get far enough to name a reason, which on
        // this path is the token itself refusing the pull. Let it abort loudly.
        _ => panic!("the router could not take the delivery"),
    }
}

// ------------------------------------------------------------------------------------------
// FailableToken
// ------------------------------------------------------------------------------------------

#[contracttype]
#[derive(Clone)]
enum TokenKey {
    Balance(Address),
    Blocked(Address),
    BalanceError(Address),
    Decimals,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum TokenError {
    InsufficientBalance = 1,
    /// What a missing trustline looks like from the caller's side: the transfer simply fails.
    RecipientCannotReceive = 2,
    NegativeAmount = 3,
}

/// A token that can be told to refuse a specific recipient.
///
/// This is the only honest way to reach the parked-claim path in a unit test. On the real
/// network the refusal comes from a classic account having no trustline for the asset, which the
/// test environment's own asset contracts will never reproduce because they open trustlines for
/// you.
#[contract]
pub struct FailableToken;

#[contractimpl]
impl FailableToken {
    pub fn init(env: Env, decimals: u32) {
        env.storage().instance().set(&TokenKey::Decimals, &decimals);
    }

    pub fn mint(env: Env, to: Address, amount: i128) {
        let current = Self::balance(env.clone(), to.clone());
        env.storage()
            .instance()
            .set(&TokenKey::Balance(to), &(current + amount));
    }

    /// Stop accepting transfers into `who`, or start again.
    pub fn set_blocked(env: Env, who: Address, blocked: bool) {
        env.storage()
            .instance()
            .set(&TokenKey::Blocked(who), &blocked);
    }

    pub fn set_balance_error(env: Env, who: Address, unavailable: bool) {
        env.storage()
            .instance()
            .set(&TokenKey::BalanceError(who), &unavailable);
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        if env
            .storage()
            .instance()
            .get::<_, bool>(&TokenKey::BalanceError(id.clone()))
            .unwrap_or(false)
        {
            env.panic_with_error(TokenError::NegativeAmount);
        }
        env.storage()
            .instance()
            .get(&TokenKey::Balance(id))
            .unwrap_or(0i128)
    }

    pub fn decimals(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&TokenKey::Decimals)
            .unwrap_or(7)
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) -> Result<(), TokenError> {
        from.require_auth();
        if amount < 0 {
            return Err(TokenError::NegativeAmount);
        }
        let blocked: bool = env
            .storage()
            .instance()
            .get(&TokenKey::Blocked(to.clone()))
            .unwrap_or(false);
        if blocked {
            return Err(TokenError::RecipientCannotReceive);
        }
        let from_balance = Self::balance(env.clone(), from.clone());
        if from_balance < amount {
            return Err(TokenError::InsufficientBalance);
        }
        let to_balance = Self::balance(env.clone(), to.clone());
        env.storage()
            .instance()
            .set(&TokenKey::Balance(from), &(from_balance - amount));
        env.storage()
            .instance()
            .set(&TokenKey::Balance(to), &(to_balance + amount));
        Ok(())
    }
}

// ------------------------------------------------------------------------------------------
// FeeOnTransferToken
// ------------------------------------------------------------------------------------------

#[contracttype]
#[derive(Clone)]
enum FotKey {
    Balance(Address),
    Decimals,
    FeeBps,
    FeeTo,
    ExtraDebit,
    Blocked(Address),
}

/// A token that charges a fee on transfer, delivering less than requested.
#[contract]
pub struct FeeOnTransferToken;

#[contractimpl]
impl FeeOnTransferToken {
    pub fn init(env: Env, decimals: u32, fee_bps: u32) {
        env.storage().instance().set(&FotKey::Decimals, &decimals);
        env.storage().instance().set(&FotKey::FeeBps, &fee_bps);
    }

    pub fn configure(env: Env, fee_to: Address, fee_bps: u32, extra_debit: bool) {
        env.storage().instance().set(&FotKey::FeeTo, &fee_to);
        env.storage().instance().set(&FotKey::FeeBps, &fee_bps);
        env.storage()
            .instance()
            .set(&FotKey::ExtraDebit, &extra_debit);
    }

    pub fn set_blocked(env: Env, to: Address, blocked: bool) {
        env.storage().instance().set(&FotKey::Blocked(to), &blocked);
    }

    pub fn mint(env: Env, to: Address, amount: i128) {
        let current = Self::balance(env.clone(), to.clone());
        env.storage()
            .instance()
            .set(&FotKey::Balance(to), &(current + amount));
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        env.storage()
            .instance()
            .get(&FotKey::Balance(id))
            .unwrap_or(0i128)
    }

    pub fn decimals(env: Env) -> u32 {
        env.storage().instance().get(&FotKey::Decimals).unwrap_or(7)
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) -> Result<(), TokenError> {
        from.require_auth();
        if amount < 0 {
            return Err(TokenError::NegativeAmount);
        }
        let from_balance = Self::balance(env.clone(), from.clone());
        if from_balance < amount {
            return Err(TokenError::InsufficientBalance);
        }
        let fee_bps: u32 = env.storage().instance().get(&FotKey::FeeBps).unwrap_or(500); // 5% fee
        let blocked: bool = env
            .storage()
            .instance()
            .get(&FotKey::Blocked(to.clone()))
            .unwrap_or(false);
        if blocked {
            return Err(TokenError::RecipientCannotReceive);
        }
        let fee_to: Option<Address> = env.storage().instance().get(&FotKey::FeeTo);
        let fee = if fee_to.is_none() || fee_to == Some(to.clone()) {
            (amount * fee_bps as i128) / 10_000
        } else {
            0
        };
        let extra: bool = env
            .storage()
            .instance()
            .get(&FotKey::ExtraDebit)
            .unwrap_or(false);
        let net = amount - fee;
        let to_balance = Self::balance(env.clone(), to.clone());
        env.storage().instance().set(
            &FotKey::Balance(from),
            &(from_balance - amount - if extra { 1 } else { 0 }),
        );
        env.storage()
            .instance()
            .set(&FotKey::Balance(to), &(to_balance + net));
        Ok(())
    }
}

// ------------------------------------------------------------------------------------------
// Helpers shared by the test modules
// ------------------------------------------------------------------------------------------

/// Every route turned on and pointed at the same mock rail, which is what most tests want.
pub fn all_routes() -> [RouteKind; 4] {
    [
        RouteKind::Cctp,
        RouteKind::AxelarIts,
        RouteKind::AxelarGmp,
        RouteKind::Allbridge,
    ]
}

/// The thirty two byte message identifier a test nonce stands for.
///
/// Rails hand over wide identifiers and the tests talk in small numbers, so this is the one
/// place the two meet. Writing the number into the tail mirrors how a CCTP v2 nonce or an
/// Axelar message id actually looks once it reaches the router.
pub fn message_id(env: &Env, nonce: u64) -> BytesN<32> {
    let mut raw = [0u8; 32];
    raw[24..].copy_from_slice(&nonce.to_be_bytes());
    BytesN::from_array(env, &raw)
}

/// A left-padded EVM address, the shape the router insists on for an outbound destination.
pub fn evm_destination(env: &Env, last_byte: u8) -> BytesN<32> {
    let mut raw = [0u8; 32];
    for (i, slot) in raw.iter_mut().enumerate().skip(12) {
        *slot = if i == 31 { last_byte } else { 0xAB };
    }
    BytesN::from_array(env, &raw)
}

/// A 32 byte word with a nonzero byte in the padding region, which is what a Stellar key looks
/// like if somebody drops it into an EVM address field by mistake.
pub fn not_an_evm_address(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[0x5Au8; 32])
}

/// Metadata-compatible contract with an error-valued balance response.
#[contract]
pub struct UnreadableBalanceToken;

#[contractimpl]
impl UnreadableBalanceToken {
    pub fn decimals(_env: Env) -> u32 {
        7
    }

    pub fn balance(_env: Env, _id: Address) -> Result<i128, TokenError> {
        Err(TokenError::InsufficientBalance)
    }
}

#[contract]
pub struct HostFailureAdapter;
#[contractimpl]
impl HostFailureAdapter {
    pub fn check_dispatch(
        env: Env,
        _caller: Address,
        _token: Address,
        _amount: i128,
        _destination_chain: String,
        _destination: BytesN<32>,
        _gas_amount: Option<i128>,
    ) {
        env.panic_with_error(soroban_sdk::Error::from_type_and_code(
            soroban_sdk::xdr::ScErrorType::Storage,
            soroban_sdk::xdr::ScErrorCode::ExceededLimit,
        ));
    }
}
