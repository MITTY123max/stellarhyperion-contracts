# Shared plumbing for the Stellar deploy scripts.
#
# Sourced, not run. Everything here is either a wrapper that fails loudly or a reader that pulls a
# value out of a JSON record without needing jq installed.

set -euo pipefail

export PATH="$HOME/.local/bin:$PATH"

CONTRACTS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOROBAN_DIR="$CONTRACTS_ROOT/soroban"
WASM_DIR="$SOROBAN_DIR/target/wasm32v1-none/release"
RECORD_DIR="$CONTRACTS_ROOT/deployments"

NETWORK="${STELLAR_NETWORK:-testnet}"
# A named identity from `stellar keys`, never a secret in the environment. The CLI keeps these in
# the user's config directory, which is outside this repository and outside any image built from
# it. A deploy script that reads a secret key out of a variable is a deploy script that eventually
# reads it out of CI logs.
IDENTITY="${STELLAR_IDENTITY:-hyperion-deploy}"

# All three write to stderr, deliberately. Several of the helpers below are called inside a
# command substitution so their stdout is a value the caller is about to use, and a progress line
# printed there becomes part of that value. That exact mistake turned a reused contract id into a
# string with a sentence in front of it, and the CLI rejected it as an invalid name. Human output
# and machine output do not share a channel in this file.
note() { printf '\n\033[1m== %s\033[0m\n' "$*" >&2; }
say()  { printf '   %s\n' "$*" >&2; }
die()  { printf '\n\033[31mfailed: %s\033[0m\n' "$*" >&2; exit 1; }

require_tools() {
  for tool in stellar node; do
    command -v "$tool" >/dev/null || die "$tool is not on PATH"
  done
}

is_dry_run() {
  [ "${HYPERION_DRY_RUN:-0}" = "1" ]
}

require_unsigned_plan() {
  is_dry_run || die "this planning helper requires HYPERION_DRY_RUN=1"
}

require_identity() {
  stellar keys address "$IDENTITY" >/dev/null 2>&1 \
    || die "no identity called $IDENTITY. Create one with:
    stellar keys generate $IDENTITY --network $NETWORK --fund
  On mainnet, add it from a hardware wallet or a secure store instead:
    stellar keys add $IDENTITY --secure-store"
}

deployer_address() { stellar keys address "$IDENTITY"; }

# Every signing command in phase one/two reserves its public intent before launching the CLI.
# A successful receipt replays only the original public output; uncertainty requires reconciliation.
journal_stellar() {
  local mode="$1"; shift
  node "$CONTRACTS_ROOT/script/stellar/operation-journal.mjs" "$mode" "$JOURNAL" \
    "${JOURNAL_PHASE:?journal phase is required}" "$NETWORK" "$(deployer_address)" -- "$@"
}

send_stellar() {
  if [ -n "${JOURNAL:-}" ]; then journal_stellar run "$@"; else stellar "$@"; fi
}

confirmed_invoke() {
  local id="$1"; shift
  [ -n "${JOURNAL:-}" ] && \
    [ "$(journal_stellar lookup contract invoke --id "$id" --source-account "$IDENTITY" --network "$NETWORK" --send yes -- "$@")" = "confirmed" ]
}

# Upload a wasm and echo its hash. Idempotent on chain: uploading the same bytes twice costs a fee
# and yields the same hash, which is why the hash is what gets written down rather than a receipt.
upload() {
  local wasm="$1"
  [ -f "$wasm" ] || die "missing $wasm; run script/stellar/build.sh first"
  send_stellar contract upload --wasm "$wasm" --source-account "$IDENTITY" --network "$NETWORK" \
    | tr -d '[:space:]'
}

deploy_from_hash() {
  local hash="$1"
  send_stellar contract deploy --wasm-hash "$hash" --source-account "$IDENTITY" --network "$NETWORK" \
    | tr -d '[:space:]'
}

# Invoke and send. Stderr is kept because a failed invoke puts the contract error there and that is
# the only thing worth reading when a deployment stops.
invoke() {
  local id="$1"; shift
  send_stellar contract invoke --id "$id" --source-account "$IDENTITY" --network "$NETWORK" --send yes -- "$@"
}

# Invoke read only. No fee, no signature, no state change.
read_only() {
  local id="$1"; shift
  stellar contract invoke --id "$id" --source-account "$IDENTITY" --network "$NETWORK" --is-view -- "$@" 2>/dev/null
}

# Only callers that classify the error capture diagnostics; they never print endpoint details.
read_only_diagnostic() {
  local id="$1"; shift
  stellar contract invoke --id "$id" --source-account "$IDENTITY" --network "$NETWORK" --is-view -- "$@"
}

# Read one top level key out of a JSON file. node rather than jq, because jq is not installed
# everywhere and node already is, since the protocol package needs it.
json_get() {
  node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=process.argv[2].split(".").reduce((a,k)=>a?.[k],d);if(v===undefined){process.stderr.write("missing key "+process.argv[2]+"\n");process.exit(1)}process.stdout.write(String(v))' "$1" "$2"
}

# The Stellar Asset Contract id for a classic asset. Derived from the code, the issuer and the
# network passphrase, so it is computed rather than looked up and never typed by a person.
sac_id() {
  local asset="$1"
  stellar contract id asset --asset "$asset" --network "$NETWORK" 2>/dev/null | tr -d '[:space:]'
}

# Rail tags, as the integers that actually go on the wire.
#
# `RouteKind` is `#[contracttype]` with `#[repr(u32)]` and explicit discriminants, which makes it a
# u32 on the wire rather than a tagged union. So the CLI wants `0`, not `Cctp` and not `"Cctp"`.
# Both of those were tried first and both were refused, the second one by the type checker rather
# than the JSON parser, which is a useful thing to have found out on a testnet.
#
# These are the same integers the Solidity enum and the TypeScript const object carry, and
# `parity.test.ts` in the protocol package is what keeps all four in agreement.
ROUTE_CCTP=0
ROUTE_AXELAR_ITS=1
ROUTE_AXELAR_GMP=2
ROUTE_ALLBRIDGE=3

# Whether a contract has been initialized already.
#
# Deployment is not atomic. An upload can succeed and a deploy fail, or a deploy succeed and an
# initialize fail on an argument the CLI would not accept, which is exactly what happened the
# first time this ran. Re-running from the top would then abandon a deployed contract and pay to
# deploy another one, so every step here asks the chain what it already did.
is_initialized() {
  local id="$1"
  local errfile
  errfile=$(mktemp)
  if read_only_diagnostic "$id" get_config >/dev/null 2>"$errfile"; then
    rm -f "$errfile"
    return 0
  fi
  if node -e 'const s=require("fs").readFileSync(process.argv[1],"utf8");process.exit(/NotInitialized|Error\(Contract, #2\)/.test(s)?0:1)' "$errfile"; then
    rm -f "$errfile"
    return 1
  fi
  rm -f "$errfile"
  die "initialization state for $id is unavailable; no initialization will be submitted"
}

# Reuse a contract id if one was handed in, otherwise deploy from a hash.
#
# The caller passes the name of an environment variable rather than its value, so an empty
# variable and an unset one behave the same way.
reuse_or_deploy() {
  local var="$1" hash="$2" label="$3"
  local existing="${!var:-}"
  if [ -n "$existing" ]; then
    say "$label reusing $existing (from $var)"
    printf '%s' "$existing"
    return
  fi
  deploy_from_hash "$hash"
}

# Hyperion's own name for the EVM chain this deployment is paired with.
peer_chain() { echo "${HYPERION_PEER_CHAIN:?set HYPERION_PEER_CHAIN, for example arc-testnet}"; }

expected_network_passphrase() {
  case "$NETWORK" in
    testnet) printf '%s' 'Test SDF Network ; September 2015' ;;
    mainnet|public) printf '%s' 'Public Global Stellar Network ; September 2015' ;;
    *) die "unsupported Stellar network alias: $NETWORK" ;;
  esac
}

assert_selected_network() {
  local expected observed
  expected=$(expected_network_passphrase)
  observed=$(stellar network info --network "$NETWORK" --output json \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s).passphrase;if(typeof v!=="string"||!v)process.exit(1);process.stdout.write(v)})') \
    || die "could not observe the selected Stellar network passphrase"
  [ "$observed" = "$expected" ] \
    || die "selected Stellar network passphrase does not match $NETWORK; refusing deployment operation"
}

assert_record_network() {
  local record="$1" chain_key="$2" recorded observed
  assert_selected_network
  recorded=$(json_get "$record" "networks.$chain_key.networkPassphrase")
  observed=$(expected_network_passphrase)
  [ "$recorded" = "$observed" ] \
    || die "record network passphrase does not match selected $NETWORK network"
}

transaction_hash_from_output() {
  node -e '
const raw=process.argv[1]||"";
let value;
try { value=JSON.parse(raw); } catch {}
let hash="";
function find(v){
  if(!v||typeof v!=="object")return;
  for(const key of ["tx_hash","txHash","transactionHash","hash"])
    if(typeof v[key]==="string"&&/^[0-9a-f]{64}$/i.test(v[key])){hash=v[key].toLowerCase();return}
  for(const child of Object.values(v))if(!hash)find(child);
}
find(value);
if(!hash)hash=(raw.match(/(?:transaction\s+hash|tx_hash|txHash|transactionHash)\s*[:=]\s*["\x27]?([0-9a-f]{64})/i)||[])[1]?.toLowerCase()||"";
process.stdout.write(hash);
' "$1"
}
