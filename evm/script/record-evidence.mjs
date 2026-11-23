#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const HASH = /^0x[0-9a-f]{64}$/i;

function readRegularJson(path) {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
      throw new Error("evidence input must be a bounded regular file");
    }
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(
        descriptor,
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_FILE_BYTES)
      throw new Error("evidence input exceeds size limit");
    return JSON.parse(buffer.subarray(0, length).toString("utf8"));
  } finally {
    closeSync(descriptor);
  }
}

function transactionHash(transaction) {
  const hash = transaction?.hash ?? transaction?.transactionHash;
  if (typeof hash !== "string" || !HASH.test(hash)) return null;
  return hash.toLowerCase();
}

function rpcClient(url) {
  let requestId = 0;
  return async (method, params) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok)
      throw new Error(`RPC ${method} returned HTTP ${response.status}`);
    const result = await response.json();
    if (result.error || result.result === undefined) {
      throw new Error(`RPC ${method} did not return a result`);
    }
    return result.result;
  };
}

function quantity(value, label) {
  if (
    typeof value !== "string" ||
    !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)
  ) {
    throw new Error(`RPC ${label} is not a canonical hex quantity`);
  }
  return BigInt(value);
}

async function position(transaction, rpc, { phase, router, deployer }) {
  const txHash = transactionHash(transaction);
  if (!txHash)
    throw new Error("broadcast file contains an invalid transaction hash");
  const liveTransaction = await rpc("eth_getTransactionByHash", [txHash]);
  if (
    !liveTransaction ||
    liveTransaction.hash?.toLowerCase() !== txHash ||
    liveTransaction.from?.toLowerCase() !== deployer.toLowerCase() ||
    (phase === "activation" && liveTransaction.to?.toLowerCase() !== router)
  ) {
    throw new Error(
      `transaction ${txHash} does not match the recorded deployer and phase`,
    );
  }
  const receipt = await rpc("eth_getTransactionReceipt", [txHash]);
  if (
    !receipt ||
    typeof receipt.transactionHash !== "string" ||
    receipt.transactionHash.toLowerCase() !== txHash ||
    receipt.status !== "0x1" ||
    !HASH.test(receipt.blockHash ?? "") ||
    typeof receipt.blockNumber !== "string"
  ) {
    throw new Error(
      `transaction ${txHash} lacks a successful canonical receipt`,
    );
  }
  if (
    phase === "initialization" &&
    receipt.contractAddress?.toLowerCase() !== router
  ) {
    throw new Error(`transaction ${txHash} did not create the recorded router`);
  }
  const block = await rpc("eth_getBlockByNumber", [receipt.blockNumber, false]);
  if (!block || block.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) {
    throw new Error(`transaction ${txHash} receipt block is not canonical`);
  }
  return {
    txHash,
    blockNumber: quantity(
      receipt.blockNumber,
      "receipt block number",
    ).toString(),
    blockHash: receipt.blockHash.toLowerCase(),
  };
}

export async function writeEvmEvidence({ phase, runPath, recordPath, rpcUrl }) {
  if (!["initialization", "activation"].includes(phase)) {
    throw new Error('phase must be "initialization" or "activation"');
  }
  if (!rpcUrl) throw new Error("HYPERION_RPC_URL or RPC_URL is required");
  const endpoint = new URL(rpcUrl);
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password
  ) {
    throw new Error(
      "RPC URL must be an HTTP(S) endpoint without embedded credentials",
    );
  }

  const run = readRegularJson(resolve(runPath));
  const record = readRegularJson(resolve(recordPath));
  const router = record.router?.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(router ?? ""))
    throw new Error("record has no valid router address");
  if (!Number.isSafeInteger(record.chainId) || record.chainId < 1) {
    throw new Error("record has no exact chain ID");
  }
  if (!/^0x[0-9a-f]{40}$/i.test(record.deployer ?? "")) {
    throw new Error("record has no valid public deployer address");
  }
  if (!HASH.test(record.genesisBlockHash ?? "")) {
    throw new Error("record has no genesis-block network binding");
  }
  if (!Array.isArray(run.transactions) || run.transactions.length > 128) {
    throw new Error("broadcast file has no bounded transaction list");
  }

  const rpc = rpcClient(endpoint.href);
  const observedChainId = quantity(await rpc("eth_chainId", []), "chain ID");
  if (observedChainId !== BigInt(record.chainId))
    throw new Error("RPC chain ID differs from the record");
  const genesis = await rpc("eth_getBlockByNumber", ["0x0", false]);
  if (genesis?.hash?.toLowerCase() !== record.genesisBlockHash.toLowerCase()) {
    throw new Error("RPC genesis block differs from the record");
  }

  const transactions = run.transactions.filter((entry) => {
    const tx = entry?.transaction ?? entry;
    if (phase === "initialization") {
      const created =
        entry?.contractAddress ??
        entry?.transaction?.contractAddress ??
        entry?.receipt?.contractAddress;
      return typeof created === "string" && created.toLowerCase() === router;
    }
    const to = tx?.to;
    return typeof to === "string" && to.toLowerCase() === router;
  });
  if (transactions.length === 0) {
    throw new Error(`broadcast file contains no router ${phase} transaction`);
  }
  const positions = [];
  for (const transaction of transactions) {
    positions.push(
      await position(transaction, rpc, {
        phase,
        router,
        deployer: record.deployer,
      }),
    );
  }
  positions.sort((left, right) => {
    const a = BigInt(left.blockNumber);
    const b = BigInt(right.blockNumber);
    return a < b ? -1 : a > b ? 1 : 0;
  });

  const prior = record.positions ?? { initialization: null, activation: [] };
  if (phase === "initialization") {
    if (positions.length !== 1)
      throw new Error("expected exactly one router creation transaction");
    if (
      prior.initialization &&
      JSON.stringify(prior.initialization) !== JSON.stringify(positions[0])
    ) {
      throw new Error(
        "initialization evidence is already recorded and cannot be overwritten",
      );
    }
    prior.initialization = positions[0];
  } else {
    const activation = Array.isArray(prior.activation) ? prior.activation : [];
    const known = new Set(
      activation.map((entry) => entry.txHash?.toLowerCase()),
    );
    prior.activation = [
      ...activation,
      ...positions.filter((entry) => !known.has(entry.txHash)),
    ];
  }
  record.positions = prior;

  const destination = resolve(recordPath);
  const temporary = `${destination}.tmp-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  try {
    renameSync(temporary, destination);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new Error(
      `could not atomically update deployment evidence: ${error.message}`,
    );
  }
  return positions;
}

async function main(args) {
  const [phase, recordPath, runPath, ...extra] = args;
  if (!phase || !recordPath || !runPath || extra.length) {
    throw new Error(
      "usage: record-evidence.mjs initialization|activation RECORD FOUNDRY_RUN_JSON",
    );
  }
  const positions = await writeEvmEvidence({
    phase,
    recordPath,
    runPath,
    rpcUrl: process.env.HYPERION_RPC_URL || process.env.RPC_URL,
  });
  process.stdout.write(
    `recorded ${positions.length} ${phase} transaction position(s)\n`,
  );
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
