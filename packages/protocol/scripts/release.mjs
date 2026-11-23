#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  cleanPackageBuild,
  collectPackageFiles,
  createPackageArchive,
  sha256,
} from "./archive.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "..", "..");

function runNpm(args, options = {}) {
  if (process.env.npm_execpath) {
    return execFileSync(process.execPath, [process.env.npm_execpath, ...args], {
      cwd: packageRoot,
      encoding: "utf8",
      stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
      timeout: 180000,
    });
  }
  return execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
    cwd: packageRoot,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    timeout: 180000,
    shell: process.platform === "win32",
  });
}

function cleanRevision() {
  const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  }).trim();
  if (status)
    throw new Error("release requires a clean source tree; commit or remove tracked changes first");
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 4096,
  }).trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(revision)) {
    throw new Error("git did not return a full source revision");
  }
  return revision;
}

function outputPath(args, name, version) {
  let output;
  if (args.length === 0) output = resolve(packageRoot, "release", `${name}-${version}.tgz`);
  else {
    if (args.length !== 2 || args[0] !== "--out" || !args[1]) {
      throw new Error("usage: release.mjs [--out ARCHIVE_PATH]");
    }
    output = resolve(args[1]);
  }
  if (!output.toLowerCase().endsWith(".tgz")) {
    throw new Error("release output must use the .tgz extension");
  }
  const insidePackage = relative(packageRoot, output);
  if (
    insidePackage === "" ||
    (insidePackage !== ".." &&
      !insidePackage.startsWith(`..${sep}`) &&
      !isAbsolute(insidePackage) &&
      !insidePackage.startsWith(`release${sep}`))
  ) {
    throw new Error("release output inside the package must be under release/");
  }
  return output;
}

function main() {
  const revision = cleanRevision();
  cleanPackageBuild(packageRoot);
  runNpm(["--ignore-scripts", "run", "build"], { inherit: true });

  const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const out = outputPath(process.argv.slice(2), packageJson.name, packageJson.version);
  const npmVersion = runNpm(["--version"]).trim();
  const files = collectPackageFiles(packageRoot);
  const archive = createPackageArchive(files);
  const manifest = {
    schemaVersion: 1,
    sourceRevision: revision,
    packageVersion: packageJson.version,
    toolchain: { node: process.version, npm: npmVersion },
    archiveSha256: sha256(archive),
    files: [...files.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, contents]) => ({ path, sha256: sha256(contents) })),
  };
  const manifestPath = `${out}.manifest.json`;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(`${out}.tmp`, archive, { flag: "w", mode: 0o644 });
  renameSync(`${out}.tmp`, out);
  writeFileSync(`${manifestPath}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: "w",
    mode: 0o644,
  });
  renameSync(`${manifestPath}.tmp`, manifestPath);
  process.stdout.write(`release archive: ${out}\n`);
  process.stdout.write(`manifest: ${manifestPath}\n`);
  process.stdout.write(`sha256: ${manifest.archiveSha256}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`release failed: ${error.message}\n`);
  process.exitCode = 1;
}
