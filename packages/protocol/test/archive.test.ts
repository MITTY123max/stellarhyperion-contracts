import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import {
  comparePackageFiles,
  createPackageArchive,
  parsePackageArchive,
  readRegularFile,
  sha256,
  smokeTestPackage,
} from "../scripts/archive.mjs";

function packageFiles(): Map<string, Buffer> {
  return new Map([
    [
      "package.json",
      Buffer.from(
        JSON.stringify({
          name: "@hyperion/protocol",
          version: "0.1.0",
          type: "module",
          exports: {
            ".": { import: "./dist/index.js" },
            "./abi": { import: "./dist/abi/index.js" },
          },
        }),
      ),
    ],
    ["README.md", Buffer.from("protocol fixture\n")],
    ["dist/index.js", Buffer.from("export const root = true;\n")],
    ["dist/abi/index.js", Buffer.from("export const abi = true;\n")],
  ]);
}

function rawArchive(
  entries: { path: string; content?: Buffer; mode?: number; type?: number }[],
): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const content = entry.content ?? Buffer.alloc(0);
    const header = Buffer.alloc(512);
    header.write(entry.path, 0, 100, "utf8");
    const octal = (offset: number, length: number, value: number) =>
      header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
    octal(100, 8, entry.mode ?? 0o644);
    octal(108, 8, 0);
    octal(116, 8, 0);
    octal(124, 12, content.length);
    octal(136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = entry.type ?? 0x30;
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    chunks.push(header, content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: 9 });
}

describe("SDK release archives", () => {
  it("reads bounded regular descriptors and rejects links and directories", () => {
    const root = mkdtempSync(join(tmpdir(), "protocol-file-boundary-"));
    try {
      const path = join(root, "source");
      const link = join(root, "link");
      writeFileSync(path, "abcd");
      symlinkSync(path, link);
      expect(readRegularFile(path, 4).toString()).toBe("abcd");
      expect(() => readRegularFile(path, 3)).toThrow(/bounded regular file|size limit/);
      expect(() => readRegularFile(link, 4)).toThrow();
      expect(() => readRegularFile(root, 4)).toThrow(/regular file/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("round-trips an archive and loads both exports in an isolated consumer", () => {
    const expected = packageFiles();
    const actual = parsePackageArchive(createPackageArchive(expected));
    expect(comparePackageFiles(actual, expected)).toEqual({
      changed: [],
      missing: [],
      extra: [],
    });
    smokeTestPackage(expected);
  });

  it("reports actual content changes, missing files and extra files with digests", () => {
    const expected = packageFiles();
    const changed = new Map(expected);
    changed.set("dist/abi/index.js", Buffer.from("export const abi = false;\n"));
    changed.delete("dist/index.js");
    changed.set("dist/unexpected.js", Buffer.from("export {};\n"));

    const result = comparePackageFiles(
      parsePackageArchive(createPackageArchive(changed)),
      expected,
    );
    expect(result.changed).toEqual([
      {
        path: "dist/abi/index.js",
        expectedSha256: sha256(expected.get("dist/abi/index.js")!),
        actualSha256: sha256(changed.get("dist/abi/index.js")!),
      },
    ]);
    expect(result.missing).toEqual([
      { path: "dist/index.js", sha256: sha256(expected.get("dist/index.js")!) },
    ]);
    expect(result.extra).toEqual([
      { path: "dist/unexpected.js", sha256: sha256(changed.get("dist/unexpected.js")!) },
    ]);
  });

  it("rejects executable entries, lifecycle hooks, duplicate entries and traversal", () => {
    expect(() =>
      parsePackageArchive(
        rawArchive([{ path: "package/bin/run.js", content: Buffer.from(""), mode: 0o755 }]),
      ),
    ).toThrow(/unexpected executable file: bin\/run\.js/);

    const hooked = packageFiles();
    hooked.set(
      "package.json",
      Buffer.from(
        JSON.stringify({
          name: "@hyperion/protocol",
          version: "0.1.0",
          scripts: { postinstall: "node hook.js" },
          exports: {
            ".": { import: "./dist/index.js" },
            "./abi": { import: "./dist/abi/index.js" },
          },
        }),
      ),
    );
    expect(() => parsePackageArchive(createPackageArchiveForTest(hooked))).toThrow(
      /lifecycle hook "postinstall"/,
    );

    const packageJson = packageFiles().get("package.json")!;
    expect(() =>
      parsePackageArchive(
        rawArchive([
          { path: "package/package.json", content: packageJson },
          { path: "package/package.json", content: packageJson },
        ]),
      ),
    ).toThrow(/duplicate archive entry: package\.json/);
    expect(() =>
      parsePackageArchive(rawArchive([{ path: "package/../escape", content: Buffer.from("x") }])),
    ).toThrow(/unsafe archive path/);
  });
});

function createPackageArchiveForTest(files: Map<string, Buffer>): Buffer {
  const entries = [...files.entries()].map(([path, content]) => ({
    path: `package/${path}`,
    content,
  }));
  return rawArchive(entries);
}
