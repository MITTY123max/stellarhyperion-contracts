export interface PackageDifferences {
  changed: Array<{
    path: string;
    expectedSha256: string;
    actualSha256: string;
  }>;
  missing: Array<{ path: string; sha256: string }>;
  extra: Array<{ path: string; sha256: string }>;
}

export const MAX_ARCHIVE_BYTES: number;
export function readRegularFile(path: string, maximum?: number): Buffer;
export function sha256(value: Uint8Array): string;
export function validatePackageManifest(manifest: unknown, path?: string): void;
export function cleanPackageBuild(packageRoot: string): void;
export function collectPackageFiles(packageRoot: string): Map<string, Buffer>;
export function createPackageArchive(files: Map<string, Buffer>): Buffer;
export function parsePackageArchive(input: Buffer): Map<string, Buffer>;
export function comparePackageFiles(
  actual: Map<string, Buffer>,
  expected: Map<string, Buffer>,
): PackageDifferences;
export function smokeTestPackage(files: Map<string, Buffer>): void;
