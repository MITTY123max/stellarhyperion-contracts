import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

export const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 4096;
const HOOKS = new Set([
  "prepublish",
  "prepare",
  "prepublishOnly",
  "prepack",
  "postpack",
  "publish",
  "postpublish",
  "preinstall",
  "install",
  "postinstall",
  "preuninstall",
  "uninstall",
  "postuninstall",
  "preversion",
  "version",
  "postversion",
]);

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertArchivePath(path) {
  if (
    typeof path !== "string" ||
    !path ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    path.split("/").some((part) => part === "" || part === "." || part === "..") ||
    path !== resolveTarPath(path)
  ) {
    throw new Error(`unsafe archive path: ${String(path)}`);
  }
}

function resolveTarPath(path) {
  const parts = [];
  for (const part of path.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== "." && part !== "") parts.push(part);
  }
  return parts.join("/");
}

export function validatePackageManifest(manifest, path = "package.json") {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`${path}: expected a package manifest object`);
  }
  if (manifest.name !== "@hyperion/protocol" || typeof manifest.version !== "string") {
    throw new Error(`${path}: unexpected package identity`);
  }
  if (manifest.dependencies && Object.keys(manifest.dependencies).length > 0) {
    throw new Error(`${path}: runtime dependencies are not permitted`);
  }
  for (const hook of HOOKS) {
    if (Object.hasOwn(manifest.scripts ?? {}, hook)) {
      throw new Error(`${path}: lifecycle hook "${hook}" is not permitted`);
    }
  }
  if (
    manifest.exports?.["."]?.import !== "./dist/index.js" ||
    manifest.exports?.["./abi"]?.import !== "./dist/abi/index.js"
  ) {
    throw new Error(`${path}: expected the "." and "./abi" import exports`);
  }
}

// Validate and read the same opened file; never reopen a checked pathname.
export function readRegularFile(path, maximum = MAX_UNCOMPRESSED_BYTES) {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maximum) {
      throw new Error(`not a bounded regular file: ${path}`);
    }
    const buffer = Buffer.alloc(Math.min(64 * 1024, maximum + 1));
    const chunks = [];
    let length = 0;
    while (true) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      length += count;
      if (length > maximum) throw new Error(`file exceeds size limit: ${path}`);
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    return Buffer.concat(chunks, length);
  } finally {
    closeSync(descriptor);
  }
}

export function collectPackageFiles(packageRoot) {
  const root = resolve(packageRoot);
  const files = new Map();
  for (const name of ["package.json", "README.md"]) {
    const path = join(root, name);
    files.set(name, readRegularFile(path));
  }

  const dist = join(root, "dist");
  if (!existsSync(dist) || !lstatSync(dist).isDirectory()) {
    throw new Error("dist is missing; build the package before archiving it");
  }
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`package source contains a symbolic link: ${relative(root, path)}`);
      }
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile()) {
        const name = relative(root, path).split(sep).join("/");
        files.set(name, readRegularFile(path));
      } else {
        throw new Error(`package source contains a special file: ${relative(root, path)}`);
      }
    }
  }
  walk(dist);
  const parsed = JSON.parse(files.get("package.json").toString("utf8"));
  validatePackageManifest(parsed);
  return files;
}

export function cleanPackageBuild(packageRoot) {
  const dist = join(resolve(packageRoot), "dist");
  try {
    const stat = lstatSync(dist);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("dist build output is not a regular directory");
    }
    rmSync(dist, { recursive: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function writeOctal(buffer, offset, length, value) {
  const text = value.toString(8).padStart(length - 1, "0");
  if (text.length > length - 1) throw new Error("archive field exceeds USTAR bounds");
  buffer.write(`${text}\0`, offset, length, "ascii");
}

function makeHeader(path, size) {
  assertArchivePath(path);
  const header = Buffer.alloc(512);
  if (Buffer.byteLength(path) > 100) {
    throw new Error(`archive path exceeds USTAR name limit: ${path}`);
  }
  header.write(path, 0, 100, "utf8");
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

export function createPackageArchive(files) {
  if (!(files instanceof Map) || files.size === 0 || files.size > MAX_FILES) {
    throw new Error("invalid packaged file set");
  }
  const entries = [...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const chunks = [];
  let total = 0;
  for (const [path, content] of entries) {
    assertArchivePath(path);
    if (!Buffer.isBuffer(content)) throw new Error(`not a file buffer: ${path}`);
    total += content.length;
    if (total > MAX_UNCOMPRESSED_BYTES) throw new Error("package exceeds size limit");
    chunks.push(makeHeader(`package/${path}`, content.length), content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  const archive = gzipSync(Buffer.concat(chunks), { level: 9 });
  if (archive.length > MAX_ARCHIVE_BYTES) throw new Error("archive exceeds size limit");
  return archive;
}

function readText(header, offset, length) {
  const bytes = header.subarray(offset, offset + length);
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end < 0 ? bytes.length : end).toString("utf8");
}

function readOctal(header, offset, length, field) {
  const text = readText(header, offset, length).trim();
  if (!/^[0-7]+$/.test(text)) throw new Error(`invalid USTAR ${field}`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) throw new Error(`unsafe USTAR ${field}`);
  return value;
}

export function parsePackageArchive(input) {
  if (!Buffer.isBuffer(input) || input.length === 0 || input.length > MAX_ARCHIVE_BYTES) {
    throw new Error("archive must be a non-empty bounded buffer");
  }
  let tar;
  try {
    tar = gunzipSync(input, { maxOutputLength: MAX_UNCOMPRESSED_BYTES });
  } catch (error) {
    throw new Error(`invalid gzip archive: ${error.message}`);
  }
  const files = new Map();
  const folded = new Set();
  let offset = 0;
  let total = 0;
  while (offset < tar.length) {
    if (offset + 512 > tar.length) throw new Error("truncated USTAR header");
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (tar.subarray(offset).some((byte) => byte !== 0)) {
        throw new Error("non-zero data follows the USTAR end marker");
      }
      break;
    }
    if (readText(header, 257, 6) !== "ustar") {
      throw new Error("unsupported archive header; expected USTAR");
    }
    const recordedChecksum = readOctal(header, 148, 8, "checksum");
    let checksum = 0;
    for (let index = 0; index < 512; index += 1) {
      checksum += index >= 148 && index < 156 ? 0x20 : header[index];
    }
    if (checksum !== recordedChecksum) throw new Error("USTAR header checksum mismatch");
    const name = readText(header, 0, 100);
    const prefix = readText(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    assertArchivePath(path);
    if (!path.startsWith("package/") || path.length === "package/".length) {
      throw new Error(`archive entry is outside package/: ${path}`);
    }
    const normalized = path.slice("package/".length);
    assertArchivePath(normalized);
    const foldedPath = normalized.toLowerCase();
    if (files.has(normalized) || folded.has(foldedPath)) {
      throw new Error(`duplicate archive entry: ${normalized}`);
    }
    folded.add(foldedPath);
    const type = header[156];
    if (type !== 0 && type !== 0x30) {
      throw new Error(
        `unsupported archive entry type for ${normalized}; links and metadata are rejected`,
      );
    }
    const mode = readOctal(header, 100, 8, "mode");
    if (mode & 0o111) throw new Error(`unexpected executable file: ${normalized}`);
    if (mode & 0o7000) throw new Error(`unexpected special file mode: ${normalized}`);
    const size = readOctal(header, 124, 12, "size");
    total += size;
    if (total > MAX_UNCOMPRESSED_BYTES || files.size >= MAX_FILES) {
      throw new Error("archive exceeds file or uncompressed size limit");
    }
    const start = offset + 512;
    const end = start + size;
    if (end > tar.length) throw new Error(`truncated archive entry: ${normalized}`);
    files.set(normalized, Buffer.from(tar.subarray(start, end)));
    offset = start + Math.ceil(size / 512) * 512;
  }
  if (files.size === 0) throw new Error("archive contains no files");
  const manifestBytes = files.get("package.json");
  if (!manifestBytes) throw new Error("archive is missing package.json");
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new Error("package.json is not valid JSON");
  }
  validatePackageManifest(manifest, "package/package.json");
  return files;
}

export function comparePackageFiles(actual, expected) {
  const changed = [];
  const missing = [];
  const extra = [];
  for (const [path, expectedBytes] of expected) {
    const actualBytes = actual.get(path);
    if (actualBytes === undefined) missing.push({ path, sha256: sha256(expectedBytes) });
    else if (!actualBytes.equals(expectedBytes)) {
      changed.push({
        path,
        expectedSha256: sha256(expectedBytes),
        actualSha256: sha256(actualBytes),
      });
    }
  }
  for (const [path, actualBytes] of actual) {
    if (!expected.has(path)) extra.push({ path, sha256: sha256(actualBytes) });
  }
  return { changed, missing, extra };
}

export function smokeTestPackage(files) {
  const temporary = mkdtempSync(join(tmpdir(), "hyperion-protocol-smoke-"));
  try {
    const packageRoot = join(temporary, "consumer", "node_modules", "@hyperion", "protocol");
    for (const [path, contents] of files) {
      const target = resolve(packageRoot, ...path.split("/"));
      if (!target.startsWith(`${packageRoot}${sep}`)) throw new Error(`unsafe smoke path: ${path}`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, contents, { flag: "wx", mode: 0o644 });
    }
    const entry = join(temporary, "consumer");
    const script = [
      'import * as protocol from "@hyperion/protocol";',
      'import * as abi from "@hyperion/protocol/abi";',
      'if (Object.keys(protocol).length === 0) throw new Error("root export is empty");',
      'if (Object.keys(abi).length === 0) throw new Error("ABI export is empty");',
    ].join("\n");
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: entry,
      encoding: "utf8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(`isolated package export smoke test failed: ${error.message}`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
