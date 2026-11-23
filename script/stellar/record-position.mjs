#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadDeploymentProtocol, readBoundedText } from "./record-evidence.mjs";
import { rpcClient } from "./restore-plan.mjs";
import { validateRpcUrl } from "./rollback-report.mjs";
import { verifyEnvelope } from "./reconcile-transaction.mjs";

const NETWORKS = {
  testnet: "stellar-testnet",
  mainnet: "stellar",
  public: "stellar",
};

export async function recordActivationPosition(
  recordPath,
  txHash,
  dependencies = {},
) {
  if (!/^[0-9a-f]{64}$/i.test(txHash)) {
    throw new Error("transaction hash must be 64 hexadecimal characters");
  }
  const absolutePath = resolve(recordPath);
  const original = JSON.parse(readBoundedText(absolutePath));
  const protocol = await loadDeploymentProtocol();
  const parsed = protocol.parseDeploymentSet(original);
  const entries = Object.entries(parsed.networks);
  if (entries.length !== 1)
    throw new Error("record must contain exactly one network");
  const [chainKey, deployment] = entries[0];
  if (deployment.family !== "stellar")
    throw new Error("activation position requires a Stellar record");
  const network = process.env.STELLAR_NETWORK || "testnet";
  if (NETWORKS[network] !== chainKey)
    throw new Error("record does not match selected Stellar network");

  const endpoint = validateRpcUrl(
    process.env.STELLAR_RPC_URL || protocol.chain(chainKey).defaultRpcUrl,
  );
  const rpc = dependencies.rpc ?? rpcClient(endpoint);
  const observed = await rpc("getNetwork", {});
  if (observed.passphrase !== deployment.networkPassphrase) {
    throw new Error("RPC network does not match the deployment record");
  }
  const transaction = await rpc("getTransaction", {
    hash: txHash.toLowerCase(),
  });
  if (
    transaction.status !== "SUCCESS" ||
    typeof transaction.envelopeXdr !== "string" ||
    !Number.isSafeInteger(transaction.ledger) ||
    transaction.ledger < 1 ||
    transaction.ledger > 0xffffffff
  ) {
    throw new Error(
      "RPC did not confirm the activation transaction at an exact ledger",
    );
  }
  const expectedSender = original.networks[chainKey].deployer;
  const decoded = (dependencies.verifyEnvelope ?? verifyEnvelope)(
    transaction.envelopeXdr,
    deployment.networkPassphrase,
  );
  if (
    decoded.hash !== txHash.toLowerCase() ||
    decoded.source !== expectedSender
  ) {
    throw new Error(
      "activation transaction hash or public deployer differs from the record",
    );
  }

  const rawDeployment = original.networks[chainKey];
  const positions = rawDeployment.positions ?? {
    initialization: null,
    activation: [],
  };
  const activation = positions.activation ?? [];
  const normalizedHash = txHash.toLowerCase();
  if (activation.some((position) => position.txHash === normalizedHash)) {
    return {
      ledger: transaction.ledger,
      txHash: normalizedHash,
      duplicate: true,
    };
  }
  positions.activation = [
    ...activation,
    { ledger: transaction.ledger, txHash: normalizedHash },
  ];
  rawDeployment.positions = positions;
  protocol.parseDeploymentSet(original);

  const temporary = `${absolutePath}.tmp-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(original, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  try {
    renameSync(temporary, absolutePath);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new Error(
      `could not atomically update deployment evidence: ${error.message}`,
    );
  }
  return {
    ledger: transaction.ledger,
    txHash: normalizedHash,
    duplicate: false,
  };
}

async function main(args) {
  const [recordPath, phase, txHash, ...extra] = args;
  if (!recordPath || phase !== "activation" || !txHash || extra.length) {
    throw new Error(
      "usage: record-position.mjs RECORD activation TRANSACTION_HASH",
    );
  }
  const position = await recordActivationPosition(recordPath, txHash);
  process.stdout.write(
    `${position.duplicate ? "already recorded" : "recorded"} activation transaction ${position.txHash} at ledger ${position.ledger}\n`,
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
