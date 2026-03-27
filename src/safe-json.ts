/**
 * Safe JSON file I/O — atomic write with tmp+rename, read with corruption recovery.
 *
 * Shared by checkpoint.ts and oracle-memory.ts. Eliminates DRY violation
 * identified in Code Quality review.
 */

import {
  writeFileSync,
  readFileSync,
  renameSync,
  mkdirSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Read and parse a JSON file. Returns null on missing file, parse error,
 * or validation failure. On parse error, renames to .bak for forensics.
 */
export function safeReadJSON<T>(
  filePath: string,
  validate?: (data: unknown) => data is T,
): T | null {
  if (!existsSync(filePath)) return null;

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt JSON — rename to .bak for forensics
    backupCorruptFile(filePath);
    return null;
  }

  if (validate && !validate(parsed)) {
    // Valid JSON but failed schema validation — rename to .bak
    backupCorruptFile(filePath);
    return null;
  }

  return parsed as T;
}

/**
 * Write JSON atomically: write to tmp file, rename to target.
 * Creates parent directories as needed.
 *
 * @param filePath - Target file path
 * @param data - Data to serialize
 * @param pretty - Use 2-space indent (default: true)
 */
export function safeWriteJSON(
  filePath: string,
  data: unknown,
  pretty: boolean = true,
): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });

  const tmpPath = `${filePath}.tmp.${randomBytes(4).toString("hex")}`;
  const serialized = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);

  writeFileSync(tmpPath, serialized, "utf-8");

  // Retry rename once on ENOENT — under heavy parallel I/O (e.g., Vitest running
  // 69 test files simultaneously), the filesystem can transiently report ENOENT
  // between writeFileSync and renameSync even though both target the same directory.
  try {
    renameSync(tmpPath, filePath);
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      // Re-create dir and retry once
      mkdirSync(dir, { recursive: true });
      writeFileSync(tmpPath, serialized, "utf-8");
      renameSync(tmpPath, filePath);
    } else {
      throw err;
    }
  }
}

/**
 * Read a plain text file safely. Returns null on missing or read error.
 * On empty file, returns empty string (not null).
 */
export function safeReadText(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Write a plain text file atomically.
 * Creates parent directories as needed.
 */
export function safeWriteText(filePath: string, content: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });

  const tmpPath = `${filePath}.tmp.${randomBytes(4).toString("hex")}`;
  writeFileSync(tmpPath, content, "utf-8");

  // Retry rename once on ENOENT (same rationale as safeWriteJSON)
  try {
    renameSync(tmpPath, filePath);
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      mkdirSync(dir, { recursive: true });
      writeFileSync(tmpPath, content, "utf-8");
      renameSync(tmpPath, filePath);
    } else {
      throw err;
    }
  }
}

/**
 * Rename a corrupt file to .bak. If .bak already exists, overwrite it.
 * Non-fatal — errors during backup are silently ignored.
 */
function backupCorruptFile(filePath: string): void {
  const bakPath = `${filePath}.bak`;
  try {
    renameSync(filePath, bakPath);
  } catch {
    // If rename fails (e.g., permissions), try to clean up
    try {
      unlinkSync(filePath);
    } catch {
      // Give up — non-fatal
    }
  }
}
