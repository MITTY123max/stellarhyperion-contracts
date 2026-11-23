/**
 * Where Hyperion actually lives, once it has been deployed somewhere.
 *
 * Nothing in this file is a constant. Addresses come from `deployments/<network>.json`, which the
 * deploy scripts write and a human reviews, and the loader below checks the shape rather than
 * casting it. That matters more than it sounds: an address with a transposed character parses
 * fine as a string, passes a cast without complaint, and turns into a transfer to nobody. The
 * validator refuses the file instead, at start up, where somebody is watching.
 *
 * Deliberately not baked into the bundle either. A frontend that hard codes a router address is a
 * frontend that needs a release to follow a redeployment, and the one time that matters is during
 * an incident.
 *
 * Lifecycle. A record may be archived (retired) and may name a successor. An archived record stays
 * in the set so its transaction evidence is never discarded, but `activeDeployment` and
 * `activeNetworks` skip it, so tooling cannot accidentally activate or monitor a retired router.
 * Consumers that name an archived record directly receive a `RetiredRouterWarning` describing the
 * successor to migrate to.
 */
import type { Hex } from "./bytes.js";
import type { ChainKey } from "./chains.js";
import { chain as chainConfig, isChainKey } from "./chains.js";
import type { AssetIdentity, AssetRepresentation } from "./registry/assets.js";
import { RouteKind } from "./routes.js";
import { ROUTE_KINDS, ROUTE_SLUGS, tryRouteFromSlug } from "./routes.js";
import { isStellarAddress } from "./addresses.js";
import type { ProviderAddressOverrides } from "./registry/assets.js";
import { MAX_DEPLOYMENT_TOKENS, MAX_DEPLOYMENT_WASM_HASHES } from "./limits.js";

/** The schema version of a deployment file, so an old file fails loudly rather than oddly. */
export const DEPLOYMENT_SCHEMA_VERSION = 1;
const MAX_UINT256 = (1n << 256n) - 1n;

export interface DeployedAtEvm {
  /** Block the router landed in, as a string because JSON numbers stop being exact above 2^53. */
  readonly blockNumber: string;
  /** ISO 8601, UTC. */
  readonly timestamp: string;
  readonly txHash: Hex;
}

export interface DeployedAtStellar {
  readonly ledger: number;
  readonly timestamp: string;
}

export interface EvmTransactionPosition {
  readonly blockNumber: string;
  readonly blockHash: Hex;
  readonly txHash: Hex;
}

export interface EvmDeploymentPositions {
  readonly initialization: EvmTransactionPosition | null;
  readonly activation: readonly EvmTransactionPosition[];
}

export interface StellarTransactionPosition {
  readonly ledger: number;
  readonly txHash: string;
}

export interface StellarDeploymentPositions {
  readonly initialization: StellarTransactionPosition | null;
  readonly activation: readonly StellarTransactionPosition[];
}

export interface EvmTokenDeployment {
  /** The ticker this token represents. Defaults to the record key when the file omits it. */
  readonly symbol: string;
  /** Native issuance or an ITS representation of the same ticker. */
  readonly representation: AssetRepresentation;
  readonly address: Hex;
  readonly decimals: number;
  /** The flow ceiling the router was configured with, in this asset's own units. */
  readonly flowLimit: string;
  /** Which rails this asset is registered for here. */
  readonly routes: readonly RouteKind[];
  /** Optional provider-side token addresses; these never replace `address` or `decimals`. */
  readonly providerAddresses?: Readonly<Partial<Record<RouteKind, Hex>>>;
}

export interface StellarTokenDeployment {
  /** The ticker this token represents. Defaults to the record key when the file omits it. */
  readonly symbol: string;
  /** Native issuance or an ITS representation of the same ticker. */
  readonly representation: AssetRepresentation;
  /** The Stellar Asset Contract id, which is what Soroban calls. */
  readonly sacId: string;
  readonly code: string;
  readonly issuer: string;
  readonly decimals: number;
  readonly flowLimit: string;
  readonly routes: readonly RouteKind[];
  /** Optional provider-side token addresses; these never replace `sacId` or `decimals`. */
  readonly providerAddresses?: Readonly<Partial<Record<RouteKind, string>>>;
}

/**
 * Lifecycle metadata shared by every deployment record.
 *
 * `status` is `active` for the record operators should use, and `archived` for one that has been
 * retired. `successor` names the chain key of the record that replaces an archived one, when there
 * is one. `archivedAt` is an ISO 8601 timestamp recorded at the moment of retirement.
 */
export interface DeploymentLifecycle {
  readonly status: "active" | "archived";
  readonly archivedAt?: string;
  readonly successor?: ChainKey;
  readonly reason?: string;
}

export interface EvmDeployment extends DeploymentLifecycle {
  readonly family: "evm";
  readonly chain: ChainKey;
  readonly chainId: number;
  /** Public genesis hash binding this record to a network, beyond its chain ID. */
  readonly genesisBlockHash?: Hex;
  readonly positions: EvmDeploymentPositions;
  readonly router: Hex;
  readonly adapters: Readonly<Partial<Record<RouteKind, Hex>>>;
  /** Keyed by symbol, because that is what a person picks from a list. */
  readonly tokens: Readonly<Record<string, EvmTokenDeployment>>;
  readonly treasury: Hex;
  readonly admin: Hex;
  readonly guardian: Hex;
  readonly feeBps: number;
  /** Seconds. The router's own flow window, not a rail's. */
  readonly flowWindow: number;
  readonly timelockDelay: number;
  readonly deployedAt: DeployedAtEvm;
  readonly evidenceLimitations: readonly string[];
  /** The commit the bytecode was built from. The only thing tying an address to a source tree. */
  readonly commit: string;
}

export interface StellarDeployment extends DeploymentLifecycle {
  readonly family: "stellar";
  readonly chain: ChainKey;
  readonly networkPassphrase: string;
  readonly router: string;
  readonly adapters: Readonly<Partial<Record<RouteKind, string>>>;
  readonly tokens: Readonly<Record<string, StellarTokenDeployment>>;
  readonly treasury: string;
  readonly admin: string;
  readonly guardian: string;
  readonly feeBps: number;
  /** Ledgers, not seconds, because that is what the Soroban side counts in. */
  readonly flowWindow: number;
  readonly timelockDelay: number;
  /** Hex hashes of the uploaded WASM, one per contract, so an installed build is identifiable. */
  readonly wasmHashes: Readonly<Record<string, string>>;
  readonly deployedAt: DeployedAtStellar;
  /** Public transaction evidence, separated by the two activation phases. */
  readonly positions: StellarDeploymentPositions;
  /** Limitations are explicit for legacy and phase-one-only records. */
  readonly evidenceLimitations: readonly string[];
  readonly commit: string;
}

export type Deployment = EvmDeployment | StellarDeployment;

export interface DeploymentSet {
  readonly schemaVersion: number;
  readonly generatedAt: string;
  readonly networks: Readonly<Partial<Record<ChainKey, Deployment>>>;
  /** Explicit activation capabilities. A registry or deployment route is not activated without this. */
  readonly routeCapabilities?: RouteCapabilitySet;
}

export const ROUTE_CAPABILITY_REVISION = 1;
export const ROUTE_CAPABILITY_SCHEMA_VERSION = ROUTE_CAPABILITY_REVISION;

export type RouteRecipientKind = "account" | "contract" | "muxed-account";
export type RecipientKind = RouteRecipientKind;

export interface RouteCapabilityRecord {
  readonly revision: number;
  readonly chain: ChainKey;
  readonly symbol: string;
  readonly route: RouteKind;
  readonly status: "active" | "gated";
  readonly paidDispatch: boolean;
  readonly recipientKinds: readonly RouteRecipientKind[];
}

export interface RouteCapabilitySet {
  readonly revision: number;
  readonly records: readonly RouteCapabilityRecord[];
}

/** Thrown when a deployment file does not hold together. Carries the path to the bad field. */
export class DeploymentFormatError extends Error {
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`deployment record invalid at ${path}: ${reason}`);
    this.name = "DeploymentFormatError";
  }
}

/**
 * Returned (not thrown) when a consumer names an archived router, so it can warn and redirect.
 * `successor` is the active record the consumer should move to, if one is named and present.
 */
export interface RetiredRouterWarning {
  readonly kind: "retired-router";
  readonly chain: ChainKey;
  readonly router: string;
  readonly archivedAt?: string;
  readonly reason?: string;
  readonly successor?: Deployment;
  readonly message: string;
}

function fail(path: string, reason: string): never {
  throw new DeploymentFormatError(path, reason);
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "expected an object");
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) fail(path, "expected a non empty string");
  return value;
}

function asInteger(value: unknown, path: string, min = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
    fail(path, `expected an integer of at least ${String(min)}`);
  }
  return value;
}

/** A decimal string, because a flow ceiling in wei does not survive a double. */
function asUintString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    // Worth its own message. A ceiling written as a JSON number is the mistake somebody makes
    // once per deployment file, and "expected a string" does not explain why.
    fail(
      path,
      "expected a decimal integer written as a string, because a large one loses precision as a JSON number",
    );
  }
  if (!/^\d+$/.test(value)) fail(path, "expected a decimal integer written as a string");
  if (value.length > 78) fail(path, "expected a uint256 value");
  if (BigInt(value) > MAX_UINT256) fail(path, "expected a uint256 value");
  return value;
}

function asEvmAddress(value: unknown, path: string): Hex {
  const text = asString(value, path);
  if (!/^0x[0-9a-fA-F]{40}$/.test(text)) fail(path, "expected a 20 byte hex address");
  return text as Hex;
}

function asHash(value: unknown, path: string): Hex {
  const text = asString(value, path);
  if (!/^0x[0-9a-fA-F]{64}$/.test(text)) fail(path, "expected a 32 byte hex hash");
  return text as Hex;
}

function asStellarContract(value: unknown, path: string): string {
  const text = asString(value, path);
  if (!text.startsWith("C") || !isStellarAddress(text)) {
    fail(path, "expected a Stellar contract id starting with C");
  }
  return text;
}

function asStellarAccount(value: unknown, path: string): string {
  const text = asString(value, path);
  if (!isStellarAddress(text)) fail(path, "expected a Stellar address");
  return text;
}

function asTimestamp(value: unknown, path: string): string {
  const text = asString(value, path);
  if (Number.isNaN(Date.parse(text))) fail(path, "expected an ISO 8601 timestamp");
  return text;
}

function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "expected a boolean");
  return value;
}

/**
 * The representation of a token record.
 *
 * Absent means `native`, which is what every record written before this field existed means, so
 * older deployment files keep loading unchanged. An unknown value is refused rather than treated
 * as native: a typo that silently promoted an ITS representation to native USDC would be the
 * expensive kind of compatible.
 */
function asRepresentation(value: unknown, path: string): AssetRepresentation {
  if (value === undefined) return "native";
  const text = asString(value, path);
  if (text !== "native" && text !== "its") {
    fail(path, 'expected "native" or "its"');
  }
  return text;
}

/** The ticker a record carries, defaulting to the map key for files that predate the field. */
function asTokenSymbol(value: unknown, path: string, key: string): string {
  return value === undefined ? key : asString(value, path);
}

function asRoutes(value: unknown, path: string): readonly RouteKind[] {
  if (!Array.isArray(value)) fail(path, "expected an array of rail slugs");
  return value.map((entry, index) => {
    const slug = asString(entry, `${path}[${String(index)}]`);
    const route = tryRouteFromSlug(slug);
    if (route === null) {
      fail(
        `${path}[${String(index)}]`,
        `unknown rail "${slug}", expected one of ${ROUTE_KINDS.map((kind) => ROUTE_SLUGS[kind]).join(", ")}`,
      );
    }
    return route;
  });
}

function asAdapters<T>(
  value: unknown,
  path: string,
  read: (entry: unknown, entryPath: string) => T,
): Partial<Record<RouteKind, T>> {
  const record = asRecord(value, path);
  const out: Partial<Record<RouteKind, T>> = {};
  for (const [slug, entry] of Object.entries(record)) {
    const route = tryRouteFromSlug(slug);
    if (route === null) fail(`${path}.${slug}`, "unknown rail slug");
    out[route] = read(entry, `${path}.${slug}`);
  }
  return out;
}

/**
 * Read the lifecycle block. Absent means active, so every record written before archival existed
 * keeps working unchanged. A present `archived` status must carry an `archivedAt`, so that every
 * retirement is dated and a reviewer can tell when it was decided.
 */
function readLifecycle(raw: Record<string, unknown>, path: string): DeploymentLifecycle {
  const status = raw.status === undefined ? "active" : raw.status;
  if (status !== "active" && status !== "archived") {
    fail(`${path}.status`, 'expected "active" or "archived"');
  }
  const archivedAt =
    raw.archivedAt === undefined ? undefined : asTimestamp(raw.archivedAt, `${path}.archivedAt`);
  if (status === "archived" && archivedAt === undefined) {
    fail(`${path}.archivedAt`, "an archived record must say when it was archived");
  }
  if (status === "active" && archivedAt !== undefined) {
    fail(`${path}.archivedAt`, "an active record cannot carry archivedAt");
  }
  let successor: ChainKey | undefined;
  if (raw.successor !== undefined) {
    const key = asString(raw.successor, `${path}.successor`);
    if (!isChainKey(key)) fail(`${path}.successor`, `unknown chain key "${key}"`);
    successor = key;
  }
  const reason = raw.reason === undefined ? undefined : asString(raw.reason, `${path}.reason`);
  return {
    status,
    ...(archivedAt !== undefined ? { archivedAt } : {}),
    ...(successor !== undefined ? { successor } : {}),
    ...(reason !== undefined ? { reason } : {}),
  };
}

function asProviderAddresses<T>(
  value: unknown,
  path: string,
  routes: readonly RouteKind[],
  adapters: Readonly<Partial<Record<RouteKind, unknown>>>,
  read: (entry: unknown, entryPath: string) => T,
): Partial<Record<RouteKind, T>> {
  const addresses = asAdapters(value, path, read);
  for (const route of ROUTE_KINDS) {
    if (addresses[route] === undefined) continue;
    if (!routes.includes(route)) {
      fail(`${path}.${ROUTE_SLUGS[route]}`, "token does not support this provider rail");
    }
    if (adapters[route] === undefined) {
      fail(`${path}.${ROUTE_SLUGS[route]}`, "deployment has no adapter for this provider rail");
    }
  }
  return addresses;
}

function readEvmDeployment(
  raw: Record<string, unknown>,
  chain: ChainKey,
  path: string,
): EvmDeployment {
  const expectedChain = chainConfig(chain);
  const chainId = asInteger(raw.chainId, `${path}.chainId`, 1);
  if (expectedChain.family !== "evm" || chainId !== expectedChain.chainId) {
    fail(`${path}.chainId`, "does not match the selected chain");
  }
  const adapters = asAdapters(raw.adapters, `${path}.adapters`, asEvmAddress);
  const tokensRaw = asRecord(raw.tokens, `${path}.tokens`);
  const tokens: Record<string, EvmTokenDeployment> = {};
  for (const [symbol, entry] of Object.entries(tokensRaw)) {
    const tokenPath = `${path}.tokens.${symbol}`;
    const token = asRecord(entry, tokenPath);
    const routes = asRoutes(token.routes, `${tokenPath}.routes`);
    const providerAddresses =
      token.providerAddresses === undefined
        ? undefined
        : asProviderAddresses(
            token.providerAddresses,
            `${tokenPath}.providerAddresses`,
            routes,
            adapters,
            asEvmAddress,
          );
    tokens[symbol] = {
      symbol: asTokenSymbol(token.symbol, `${tokenPath}.symbol`, symbol),
      representation: asRepresentation(token.representation, `${tokenPath}.representation`),
      address: asEvmAddress(token.address, `${tokenPath}.address`),
      decimals: asInteger(token.decimals, `${tokenPath}.decimals`),
      flowLimit: asUintString(token.flowLimit, `${tokenPath}.flowLimit`),
      routes,
      ...(providerAddresses === undefined ? {} : { providerAddresses }),
    };
  }

  const deployedAt = asRecord(raw.deployedAt, `${path}.deployedAt`);
  const positionsRaw =
    raw.positions === undefined ? null : asRecord(raw.positions, `${path}.positions`);
  const initializationRaw =
    positionsRaw?.initialization === undefined || positionsRaw.initialization === null
      ? null
      : asRecord(positionsRaw.initialization, `${path}.positions.initialization`);
  const activationRaw = positionsRaw?.activation === undefined ? [] : positionsRaw.activation;
  if (!Array.isArray(activationRaw) || activationRaw.length > 128) {
    fail(`${path}.positions.activation`, "expected a bounded transaction array");
  }
  function readPosition(value: unknown, positionPath: string): EvmTransactionPosition {
    const position = asRecord(value, positionPath);
    return {
      blockNumber: asUintString(position.blockNumber, `${positionPath}.blockNumber`),
      blockHash: asHash(position.blockHash, `${positionPath}.blockHash`),
      txHash: asHash(position.txHash, `${positionPath}.txHash`),
    };
  }
  const initialization = initializationRaw
    ? readPosition(initializationRaw, `${path}.positions.initialization`)
    : null;
  const activation = activationRaw.map((position, index) =>
    readPosition(position, `${path}.positions.activation[${String(index)}]`),
  );
  return {
    family: "evm",
    chain,
    chainId,
    ...(raw.genesisBlockHash === undefined
      ? {}
      : { genesisBlockHash: asHash(raw.genesisBlockHash, `${path}.genesisBlockHash`) }),
    positions: { initialization, activation },
    router: asEvmAddress(raw.router, `${path}.router`),
    adapters,
    tokens,
    treasury: asEvmAddress(raw.treasury, `${path}.treasury`),
    admin: asEvmAddress(raw.admin, `${path}.admin`),
    guardian: asEvmAddress(raw.guardian, `${path}.guardian`),
    feeBps: asInteger(raw.feeBps, `${path}.feeBps`),
    flowWindow: asInteger(raw.flowWindow, `${path}.flowWindow`, 1),
    timelockDelay: asInteger(raw.timelockDelay, `${path}.timelockDelay`),
    deployedAt: {
      blockNumber: asUintString(deployedAt.blockNumber, `${path}.deployedAt.blockNumber`),
      timestamp: asTimestamp(deployedAt.timestamp, `${path}.deployedAt.timestamp`),
      txHash: asHash(deployedAt.txHash, `${path}.deployedAt.txHash`),
    },
    evidenceLimitations: [
      ...(raw.genesisBlockHash === undefined
        ? ["genesis-block network binding unavailable in legacy record"]
        : []),
      ...(initialization ? [] : ["initialization transaction evidence unavailable"]),
      ...(activation.length ? [] : ["activation transaction evidence unavailable"]),
    ],
    commit: asString(raw.commit, `${path}.commit`),
    ...readLifecycle(raw, path),
  };
}

function readStellarDeployment(
  raw: Record<string, unknown>,
  chain: ChainKey,
  path: string,
): StellarDeployment {
  const expectedChain = chainConfig(chain);
  if (
    expectedChain.family !== "stellar" ||
    raw.networkPassphrase !== expectedChain.networkPassphrase
  ) {
    fail(`${path}.networkPassphrase`, "does not match the selected Stellar network");
  }
  const adapters = asAdapters(raw.adapters, `${path}.adapters`, asStellarContract);
  const tokensRaw = asRecord(raw.tokens, `${path}.tokens`);
  const tokenEntries = Object.entries(tokensRaw);
  if (tokenEntries.length > MAX_DEPLOYMENT_TOKENS) {
    fail(
      `${path}.tokens`,
      `more than ${String(MAX_DEPLOYMENT_TOKENS)} token entries exceeds the record input limit`,
    );
  }
  const tokens: Record<string, StellarTokenDeployment> = {};
  for (const [symbol, entry] of tokenEntries) {
    const tokenPath = `${path}.tokens.${symbol}`;
    const token = asRecord(entry, tokenPath);
    const routes = asRoutes(token.routes, `${tokenPath}.routes`);
    const providerAddresses =
      token.providerAddresses === undefined
        ? undefined
        : asProviderAddresses(
            token.providerAddresses,
            `${tokenPath}.providerAddresses`,
            routes,
            adapters,
            asStellarContract,
          );
    tokens[symbol] = {
      symbol: asTokenSymbol(token.symbol, `${tokenPath}.symbol`, symbol),
      representation: asRepresentation(token.representation, `${tokenPath}.representation`),
      sacId: asStellarContract(token.sacId, `${tokenPath}.sacId`),
      code: asString(token.code, `${tokenPath}.code`),
      issuer: asStellarAccount(token.issuer, `${tokenPath}.issuer`),
      decimals: asInteger(token.decimals, `${tokenPath}.decimals`),
      flowLimit: asUintString(token.flowLimit, `${tokenPath}.flowLimit`),
      routes,
      ...(providerAddresses === undefined ? {} : { providerAddresses }),
    };
  }

  const hashesRaw = asRecord(raw.wasmHashes, `${path}.wasmHashes`);
  const hashEntries = Object.entries(hashesRaw);
  if (hashEntries.length > MAX_DEPLOYMENT_WASM_HASHES) {
    fail(
      `${path}.wasmHashes`,
      `more than ${String(MAX_DEPLOYMENT_WASM_HASHES)} wasm hashes exceeds the record input limit`,
    );
  }
  const wasmHashes: Record<string, string> = {};
  for (const [name, entry] of hashEntries) {
    const hash = asString(entry, `${path}.wasmHashes.${name}`);
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      fail(`${path}.wasmHashes.${name}`, "expected 64 lowercase hex characters");
    }
    wasmHashes[name] = hash;
  }

  const deployedAt = asRecord(raw.deployedAt, `${path}.deployedAt`);
  const positionsRaw =
    raw.positions === undefined ? null : asRecord(raw.positions, `${path}.positions`);
  const initializationRaw =
    positionsRaw?.initialization === undefined || positionsRaw.initialization === null
      ? null
      : asRecord(positionsRaw.initialization, `${path}.positions.initialization`);
  const activationRaw = positionsRaw?.activation === undefined ? [] : positionsRaw.activation;
  if (!Array.isArray(activationRaw) || activationRaw.length > 128) {
    fail(`${path}.positions.activation`, "expected a bounded transaction array");
  }
  function readPosition(value: unknown, positionPath: string): StellarTransactionPosition {
    const position = asRecord(value, positionPath);
    const txHash = asString(position.txHash, `${positionPath}.txHash`);
    if (!/^[0-9a-f]{64}$/.test(txHash)) {
      fail(`${positionPath}.txHash`, "expected 64 lowercase hex characters");
    }
    return {
      ledger: asInteger(position.ledger, `${positionPath}.ledger`, 1),
      txHash,
    };
  }
  const initialization = initializationRaw
    ? readPosition(initializationRaw, `${path}.positions.initialization`)
    : null;
  const activation = activationRaw.map((position, index) =>
    readPosition(position, `${path}.positions.activation[${String(index)}]`),
  );
  const evidenceLimitations = [
    ...(initialization ? [] : ["initialization transaction evidence unavailable"]),
    ...(activation.length ? [] : ["activation transaction evidence unavailable"]),
  ];
  return {
    family: "stellar",
    chain,
    networkPassphrase: asString(raw.networkPassphrase, `${path}.networkPassphrase`),
    router: asStellarContract(raw.router, `${path}.router`),
    adapters,
    tokens,
    treasury: asStellarAccount(raw.treasury, `${path}.treasury`),
    admin: asStellarAccount(raw.admin, `${path}.admin`),
    guardian: asStellarAccount(raw.guardian, `${path}.guardian`),
    feeBps: asInteger(raw.feeBps, `${path}.feeBps`),
    flowWindow: asInteger(raw.flowWindow, `${path}.flowWindow`, 1),
    timelockDelay: asInteger(raw.timelockDelay, `${path}.timelockDelay`),
    wasmHashes,
    deployedAt: {
      ledger: asInteger(deployedAt.ledger, `${path}.deployedAt.ledger`, 1),
      timestamp: asTimestamp(deployedAt.timestamp, `${path}.deployedAt.timestamp`),
    },
    positions: { initialization, activation },
    evidenceLimitations,
    commit: asString(raw.commit, `${path}.commit`),
    ...readLifecycle(raw, path),
  };
}

export function parseRouteCapabilitySet(value: unknown): RouteCapabilitySet {
  const raw = asRecord(value, "$.routeCapabilities");
  const revision = asInteger(raw.revision, "$.routeCapabilities.revision", 1);
  if (revision !== ROUTE_CAPABILITY_REVISION) {
    fail(
      "$.routeCapabilities.revision",
      `unknown route capability revision ${String(revision)}; expected ${String(ROUTE_CAPABILITY_REVISION)}`,
    );
  }
  const recordsRaw = asRecord(raw, "$.routeCapabilities");
  const entries = recordsRaw.records ?? recordsRaw.entries;
  if (!Array.isArray(entries)) {
    fail("$.routeCapabilities.records", "expected an array");
  }

  const records: RouteCapabilityRecord[] = [];
  const identities = new Set<string>();
  for (let index = 0; index < entries.length; index += 1) {
    const path = `$.routeCapabilities.records[${String(index)}]`;
    const entry = asRecord(entries[index], path);
    const recordRevision = asInteger(entry.revision, `${path}.revision`, 1);
    if (recordRevision !== ROUTE_CAPABILITY_REVISION) {
      fail(`${path}.revision`, `unknown route capability revision ${String(recordRevision)}`);
    }
    const chainName = asString(entry.chain, `${path}.chain`);
    if (!isChainKey(chainName)) fail(`${path}.chain`, `unknown chain key "${chainName}"`);
    const symbol = asString(entry.symbol, `${path}.symbol`);
    const routeSlug = asString(entry.route, `${path}.route`);
    const route = tryRouteFromSlug(routeSlug);
    if (route === null) fail(`${path}.route`, `unknown rail slug "${routeSlug}"`);

    const status = asString(entry.status, `${path}.status`);
    if (status !== "active" && status !== "gated") {
      fail(`${path}.status`, 'expected "active" or "gated"');
    }
    const paidDispatch = asBoolean(entry.paidDispatch, `${path}.paidDispatch`);

    const recipientRaw = entry.recipientKinds;
    if (!Array.isArray(recipientRaw)) {
      fail(`${path}.recipientKinds`, "expected an array");
    }
    const recipientKinds: RouteRecipientKind[] = [];
    const recipientSeen = new Set<RouteRecipientKind>();
    for (let recipientIndex = 0; recipientIndex < recipientRaw.length; recipientIndex += 1) {
      const recipientPath = `${path}.recipientKinds[${String(recipientIndex)}]`;
      const recipient = asString(recipientRaw[recipientIndex], recipientPath);
      if (recipient !== "account" && recipient !== "contract" && recipient !== "muxed-account") {
        fail(recipientPath, 'expected "account", "contract", or "muxed-account"');
      }
      if (recipientSeen.has(recipient)) fail(recipientPath, "duplicate recipient kind");
      recipientSeen.add(recipient);
      recipientKinds.push(recipient);
    }

    const identity = `${chainName}:${symbol}:${ROUTE_SLUGS[route]}`;
    if (identities.has(identity)) {
      fail(path, "duplicate capability identity");
    }
    identities.add(identity);
    records.push(
      Object.freeze({
        revision: recordRevision,
        chain: chainName,
        symbol,
        route,
        status,
        paidDispatch,
        recipientKinds: Object.freeze(recipientKinds),
      }),
    );
  }
  return Object.freeze({ revision, records: Object.freeze(records) });
}

export const parseRouteCapabilities = parseRouteCapabilitySet;

export function routeCapabilityFor(
  set: RouteCapabilitySet | DeploymentSet,
  chain: ChainKey,
  symbol: string,
  route: RouteKind,
): RouteCapabilityRecord | null {
  const supplied: unknown = set;
  if (typeof supplied !== "object" || supplied === null) return null;
  const capabilitySet = "records" in set && "revision" in set ? set : set.routeCapabilities;
  if (capabilitySet?.revision !== ROUTE_CAPABILITY_REVISION) return null;
  const entries: readonly unknown[] = capabilitySet.records;
  if (!Array.isArray(entries)) return null;
  const matches: RouteCapabilityRecord[] = [];
  for (const entry of entries) {
    if (!validCapabilityRecord(entry)) return null;
    if (entry.chain === chain && entry.symbol === symbol && entry.route === route)
      matches.push(entry);
  }
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function validCapabilityRecord(value: unknown): value is RouteCapabilityRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    record.revision !== ROUTE_CAPABILITY_REVISION ||
    typeof record.chain !== "string" ||
    !isChainKey(record.chain) ||
    typeof record.symbol !== "string" ||
    !record.symbol ||
    record.symbol.length > 4096 ||
    typeof record.route !== "number" ||
    !ROUTE_KINDS.includes(record.route as RouteKind) ||
    (record.status !== "active" && record.status !== "gated") ||
    typeof record.paidDispatch !== "boolean" ||
    !Array.isArray(record.recipientKinds)
  )
    return false;
  const recipients: readonly unknown[] = record.recipientKinds;
  return (
    !recipients.some(
      (kind) => kind !== "account" && kind !== "contract" && kind !== "muxed-account",
    ) && new Set(recipients).size === recipients.length
  );
}

export const routeCapability = routeCapabilityFor;

export function hasActivatedRouteCapability(
  set: DeploymentSet,
  chain: ChainKey,
  symbol: string,
  route: RouteKind,
): boolean {
  const deployment = set.networks[chain];
  if (deployment?.status !== "active") return false;
  if (!deployment.adapters[route]) return false;
  const token = deployment.tokens[symbol];
  if (!token?.routes.includes(route)) return false;
  return routeCapabilityFor(set, chain, symbol, route)?.status === "active";
}

export const isRouteCapabilityActive = hasActivatedRouteCapability;

export function supportsPaidDispatch(
  set: DeploymentSet,
  chain: ChainKey,
  symbol: string,
  route: RouteKind,
): boolean {
  return (
    hasActivatedRouteCapability(set, chain, symbol, route) &&
    routeCapabilityFor(set, chain, symbol, route)?.paidDispatch === true
  );
}

export function supportsRecipientKind(
  set: DeploymentSet,
  chain: ChainKey,
  symbol: string,
  route: RouteKind,
  recipientKind: RouteRecipientKind,
): boolean {
  if (!hasActivatedRouteCapability(set, chain, symbol, route)) return false;
  return (
    routeCapabilityFor(set, chain, symbol, route)?.recipientKinds.includes(recipientKind) === true
  );
}

/**
 * Read a deployment set, checking every field.
 *
 * Takes `unknown` on purpose. The input is a parsed JSON file or an HTTP response body, and both
 * of those are somebody else's output no matter how much this repository wrote them.
 *
 * Also checks the successor graph: a successor must name a record present in the same set, must
 * not name itself, and must itself be active. A chain of archived records pointing at each other
 * is refused, because a warning that redirects to another retired router is no warning at all.
 */
export function parseDeploymentSet(value: unknown): DeploymentSet {
  const raw = asRecord(value, "$");
  const schemaVersion = asInteger(raw.schemaVersion, "$.schemaVersion", 1);
  if (schemaVersion !== DEPLOYMENT_SCHEMA_VERSION) {
    fail(
      "$.schemaVersion",
      `this build reads schema ${String(DEPLOYMENT_SCHEMA_VERSION)}, file is ${String(schemaVersion)}`,
    );
  }
  const generatedAt = asTimestamp(raw.generatedAt, "$.generatedAt");
  const networksRaw = asRecord(raw.networks, "$.networks");
  const networks: Partial<Record<ChainKey, Deployment>> = {};
  for (const [key, entry] of Object.entries(networksRaw)) {
    if (!isChainKey(key)) fail(`$.networks.${key}`, "unknown chain key");
    const path = `$.networks.${key}`;
    const record = asRecord(entry, path);
    const family = record.family;
    if (family === "evm") {
      if (chainConfig(key).family !== "evm")
        fail(`${path}.family`, "does not match the chain family");
      networks[key] = readEvmDeployment(record, key, path);
    } else if (family === "stellar") {
      if (chainConfig(key).family !== "stellar") {
        fail(`${path}.family`, "does not match the chain family");
      }
      networks[key] = readStellarDeployment(record, key, path);
    } else {
      fail(`${path}.family`, 'expected "evm" or "stellar"');
    }
  }

  for (const [key, deployment] of Object.entries(networks) as [ChainKey, Deployment][]) {
    if (deployment.successor === undefined) continue;
    const path = `$.networks.${key}.successor`;
    if (deployment.successor === key) fail(path, "a record cannot succeed itself");
    const next = networks[deployment.successor];
    if (next === undefined) fail(path, `successor "${deployment.successor}" is not in this set`);
    if (next.status !== "active") {
      fail(
        path,
        `successor "${deployment.successor}" is itself archived; successors must be active`,
      );
    }
  }

  const routeCapabilities =
    raw.routeCapabilities === undefined
      ? undefined
      : parseRouteCapabilitySet(raw.routeCapabilities);
  if (routeCapabilities !== undefined) {
    for (const record of routeCapabilities.records) {
      const deployment = networks[record.chain];
      if (deployment?.status !== "active") continue;
      if (deployment.tokens[record.symbol] === undefined) {
        fail(
          `$.routeCapabilities.records`,
          `capability names unknown token "${record.symbol}" on ${record.chain}`,
        );
      }
    }
  }

  return {
    schemaVersion,
    generatedAt,
    networks,
    ...(routeCapabilities !== undefined ? { routeCapabilities } : {}),
  };
}

/** Records that are still in service. Archived records are excluded by construction. */
export function activeNetworks(set: DeploymentSet): Partial<Record<ChainKey, Deployment>> {
  const out: Partial<Record<ChainKey, Deployment>> = {};
  for (const [key, deployment] of Object.entries(set.networks) as [ChainKey, Deployment][]) {
    if (deployment.status === "active") out[key] = deployment;
  }
  return out;
}

/**
 * The active deployment for a chain, or `undefined` if there is none.
 *
 * An archived record returns `undefined` rather than itself. Callers that must still reason about a
 * retired router (to warn, or to show history) use `findDeployment` and inspect `status`.
 */
export function activeDeployment(set: DeploymentSet, chain: ChainKey): Deployment | undefined {
  const deployment = set.networks[chain];
  return deployment?.status === "active" ? deployment : undefined;
}

/** Any record for a chain, active or archived, for history and evidence lookups. */
export function findDeployment(set: DeploymentSet, chain: ChainKey): Deployment | undefined {
  return set.networks[chain];
}

/**
 * Build a warning for a consumer that has named a router. Returns `null` for an active record, so
 * the common path costs one comparison. For an archived record it returns a structured warning that
 * includes the active successor when one is named and present.
 */
export function retiredRouterWarning(
  set: DeploymentSet,
  chain: ChainKey,
): RetiredRouterWarning | null {
  const deployment = set.networks[chain];
  if (deployment === undefined || deployment.status === "active") return null;
  const successor =
    deployment.successor !== undefined ? set.networks[deployment.successor] : undefined;
  const activeSuccessor = successor?.status === "active" ? successor : undefined;
  const target =
    activeSuccessor !== undefined
      ? `migrate to ${activeSuccessor.chain} (router ${activeSuccessor.family === "stellar" ? activeSuccessor.router : activeSuccessor.router})`
      : "no active successor is recorded; do not activate or monitor this router";
  return {
    kind: "retired-router",
    chain,
    router: deployment.family === "stellar" ? deployment.router : deployment.router,
    ...(deployment.archivedAt !== undefined ? { archivedAt: deployment.archivedAt } : {}),
    ...(deployment.reason !== undefined ? { reason: deployment.reason } : {}),
    ...(activeSuccessor !== undefined ? { successor: activeSuccessor } : {}),
    message: `router for ${chain} is archived (${target})`,
  };
}

/**
 * Whether the supplied deployment has the narrowly validated source-side wiring for outbound
 * destination-minimum planning.
 *
 * This is intentionally not a general rail capability check: only Stellar Testnet CCTP and ITS
 * have independent outbound validation today. A configured adapter and token route are both
 * required, and merely adding another route to a deployment record does not enable this feature.
 */
export function hasValidatedOutboundQuoteWiring(
  set: DeploymentSet,
  chain: ChainKey,
  symbol: string,
  route: RouteKind,
): boolean {
  if (chain !== "stellar-testnet" || (route !== RouteKind.Cctp && route !== RouteKind.AxelarIts)) {
    return false;
  }
  const deployment = set.networks[chain];
  if (deployment?.status !== "active" || deployment.family !== "stellar") return false;
  const token = deployment.tokens[symbol];
  return deployment.adapters[route] !== undefined && token?.routes.includes(route) === true;
}

/** Collect deployment-scoped provider addresses into the endpoint-independent quote shape. */
export function providerAddressOverridesFromDeploymentSet(
  set: DeploymentSet,
): ProviderAddressOverrides {
  const overrides: Partial<Record<ChainKey, Record<string, Partial<Record<RouteKind, string>>>>> =
    {};
  for (const chainName of Object.keys(set.networks)) {
    if (!isChainKey(chainName)) continue;
    const deployment = set.networks[chainName];
    if (deployment === undefined) continue;
    for (const symbol of Object.keys(deployment.tokens)) {
      const token = deployment.tokens[symbol];
      if (token === undefined) continue;
      if (token.providerAddresses === undefined) continue;
      const bySymbol = (overrides[chainName] ??= {});
      bySymbol[symbol] = token.providerAddresses;
    }
  }
  return overrides;
}

export function isEvmDeployment(deployment: Deployment): deployment is EvmDeployment {
  return deployment.family === "evm";
}

export function isStellarDeployment(deployment: Deployment): deployment is StellarDeployment {
  return deployment.family === "stellar";
}

export function deploymentFor(set: DeploymentSet, chain: ChainKey): Deployment | null {
  return set.networks[chain] ?? null;
}

/** The adapter for a rail on a chain, or null when that rail is not wired up there. */
export function adapterFor(set: DeploymentSet, chain: ChainKey, route: RouteKind): string | null {
  const deployment = set.networks[chain];
  if (deployment === undefined) return null;
  return deployment.adapters[route] ?? null;
}

/** The token entries of a deployment, with the family the record declares. */
function deployedTokens(
  deployment: Deployment,
): readonly (EvmTokenDeployment | StellarTokenDeployment)[] {
  if (isEvmDeployment(deployment)) return Object.values(deployment.tokens);
  return Object.values(deployment.tokens);
}

export function tokenFor(
  set: DeploymentSet,
  chain: ChainKey,
  symbol: string,
): EvmTokenDeployment | StellarTokenDeployment | null {
  const deployment = set.networks[chain];
  if (deployment === undefined) return null;
  const matches = deployedTokens(deployment).filter((token) => token.symbol === symbol);
  // A record may list native USDC and an ITS representation of it under the same ticker. Picking
  // the first would price the wrong decimals and register the wrong address on the next deploy,
  // so an ambiguous symbol answers null and the caller has to name the representation.
  const [only] = matches;
  return only !== undefined && matches.length === 1 ? only : null;
}

/** Everything the caller knows about the token it wants, without relying on a symbol alone. */
export interface TokenQuery {
  /** The ticker. Matching on symbol alone may be ambiguous. */
  readonly symbol?: string;
  /** Native issuance or an ITS representation. Required to separate two same-symbol tokens. */
  readonly representation?: AssetRepresentation;
  /** EVM contract address. Case insensitive. */
  readonly address?: string;
  /** Stellar classic asset code. */
  readonly code?: string;
  /** Stellar issuing account. */
  readonly issuer?: string;
  /** Stellar Asset Contract id. */
  readonly sacId?: string;
  /** Only tokens registered for this rail. */
  readonly route?: RouteKind;
}

export type TokenResolution =
  | { readonly ok: true; readonly token: EvmTokenDeployment | StellarTokenDeployment }
  | {
      readonly ok: false;
      readonly reason: "not-found" | "ambiguous";
      readonly candidates: readonly (EvmTokenDeployment | StellarTokenDeployment)[];
    };

function sameHex(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function matchesTokenQuery(
  token: EvmTokenDeployment | StellarTokenDeployment,
  query: TokenQuery,
): boolean {
  if (query.symbol !== undefined && token.symbol !== query.symbol) return false;
  if (query.representation !== undefined && token.representation !== query.representation) {
    return false;
  }
  if (query.route !== undefined && !token.routes.includes(query.route)) return false;

  if ("address" in token) {
    if (query.code !== undefined || query.issuer !== undefined || query.sacId !== undefined) {
      return false;
    }
    return query.address === undefined || sameHex(token.address, query.address);
  }

  if (query.address !== undefined) return false;
  if (query.code !== undefined && token.code !== query.code) return false;
  if (query.issuer !== undefined && token.issuer !== query.issuer) return false;
  if (query.sacId !== undefined && token.sacId !== query.sacId) return false;
  return true;
}

/** Resolve one deployed token, or say why the record cannot name exactly one. */
export function resolveToken(
  set: DeploymentSet,
  chain: ChainKey,
  query: TokenQuery,
): TokenResolution {
  const deployment = set.networks[chain];
  if (deployment === undefined) return { ok: false, reason: "not-found", candidates: [] };
  const candidates = deployedTokens(deployment).filter((token) => matchesTokenQuery(token, query));
  const [only] = candidates;
  if (only !== undefined && candidates.length === 1) return { ok: true, token: only };
  if (candidates.length === 0) return { ok: false, reason: "not-found", candidates };
  return { ok: false, reason: "ambiguous", candidates };
}

/** The identity a deployment record's token actually has on its chain. */
export function tokenIdentity(
  chain: ChainKey,
  token: EvmTokenDeployment | StellarTokenDeployment,
): AssetIdentity {
  if ("address" in token) {
    return {
      family: "evm",
      chain,
      representation: token.representation,
      address: token.address,
    };
  }
  return {
    family: "stellar",
    chain,
    representation: token.representation,
    code: token.code,
    issuer: token.issuer,
  };
}

/** Look a token up by its full identity instead of by its ticker. */
export function tokenByIdentity(
  set: DeploymentSet,
  identity: AssetIdentity,
): EvmTokenDeployment | StellarTokenDeployment | null {
  const deployment = set.networks[identity.chain];
  if (deployment === undefined) return null;
  const matches = deployedTokens(deployment).filter(
    (token) =>
      tokenIdentity(identity.chain, token).family === identity.family &&
      matchesTokenQuery(
        token,
        identity.family === "evm"
          ? {
              representation: identity.representation,
              address: identity.address,
            }
          : {
              representation: identity.representation,
              code: identity.code,
              issuer: identity.issuer,
            },
      ),
  );
  const [only] = matches;
  return only !== undefined && matches.length === 1 ? only : null;
}

/** Every chain in a set that has a router, which is the list a chain picker should offer. */
export function deployedChains(set: DeploymentSet): readonly ChainKey[] {
  return Object.keys(set.networks).filter(isChainKey);
}
