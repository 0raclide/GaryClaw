/**
 * Tests for project type wiring into prompt builders (evaluate, bootstrap)
 * and doctor check #10 (stale project type cache).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  utimesSync,
} from "node:fs";
import { join } from "node:path";

import {
  checkStaleProjectTypeCache,
  PROJECT_TYPE_MAX_AGE_MS,
  type DoctorOptions,
} from "../src/doctor.js";
import { safeWriteJSON } from "../src/safe-json.js";

const TEST_DIR = join(process.cwd(), ".test-pt-wiring-tmp");
const GARYCLAW_DIR = join(TEST_DIR, ".garyclaw");

function defaultOptions(overrides?: Partial<DoctorOptions>): DoctorOptions {
  return {
    projectDir: TEST_DIR,
    fix: false,
    skipAuth: true,
    ...overrides,
  };
}

describe("project-type-wiring", () => {
  beforeEach(() => mkdirSync(GARYCLAW_DIR, { recursive: true }));
  afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  // ── Doctor check #10: stale project type cache ──────────────────

  describe("checkStaleProjectTypeCache", () => {
    it("PASS when no cache file exists", () => {
      const result = checkStaleProjectTypeCache(defaultOptions());
      expect(result.status).toBe("PASS");
      expect(result.name).toBe("project-type-cache");
      expect(result.message).toContain("No project type cache");
    });

    it("PASS when cache is fresh (< 30 days)", () => {
      const cacheFile = join(GARYCLAW_DIR, "project-type.json");
      safeWriteJSON(cacheFile, { type: "cli", confidence: 0.9, evidence: [], frameworks: [], hasWebUI: false, hasTestSuite: true });

      const result = checkStaleProjectTypeCache(defaultOptions());
      expect(result.status).toBe("PASS");
      expect(result.message).toContain("day(s) old");
    });

    it("WARN when cache is stale (> 30 days)", () => {
      const cacheFile = join(GARYCLAW_DIR, "project-type.json");
      safeWriteJSON(cacheFile, { type: "cli", confidence: 0.9, evidence: [], frameworks: [], hasWebUI: false, hasTestSuite: true });

      // Set mtime to 31 days ago
      const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
      utimesSync(cacheFile, oldDate, oldDate);

      const result = checkStaleProjectTypeCache(defaultOptions());
      expect(result.status).toBe("WARN");
      expect(result.fixable).toBe(true);
      expect(result.message).toContain("stale");
      expect(result.details).toBeDefined();
      expect(result.details![0]).toContain("31");
    });

    it("WARN with fix re-detects project type", () => {
      const cacheFile = join(GARYCLAW_DIR, "project-type.json");
      safeWriteJSON(cacheFile, { type: "cli", confidence: 0.9, evidence: [], frameworks: [], hasWebUI: false, hasTestSuite: true });

      // Set mtime to 31 days ago
      const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
      utimesSync(cacheFile, oldDate, oldDate);

      const result = checkStaleProjectTypeCache(defaultOptions({ fix: true }));
      expect(result.status).toBe("WARN");
      expect(result.fixed).toBe(true);
      expect(result.details).toBeDefined();
      expect(result.details!.some((d) => d.includes("re-detected"))).toBe(true);
    });

    it("PROJECT_TYPE_MAX_AGE_MS equals 30 days", () => {
      expect(PROJECT_TYPE_MAX_AGE_MS).toBe(30 * 24 * 60 * 60 * 1000);
    });
  });

  // ── buildEvaluatePrompt project type injection ──────────────────

  describe("buildEvaluatePrompt project type", () => {
    it("includes Project Type section when project has signals", async () => {
      // Create CLAUDE.md with CLI signal
      writeFileSync(join(TEST_DIR, "CLAUDE.md"), "# My CLI Tool\nA command-line tool for testing.");

      // Import dynamically to avoid circular dependency issues
      const { buildEvaluatePrompt } = await import("../src/evaluate.js");
      const config = { projectDir: TEST_DIR } as any;
      const prompt = buildEvaluatePrompt(config, [], TEST_DIR);
      expect(prompt).toContain("## Project Type");
      expect(prompt).toContain("CLI tool");
    });

    it("omits Project Type section for unknown projects", async () => {
      // No CLAUDE.md, no package.json → unknown type
      const { buildEvaluatePrompt } = await import("../src/evaluate.js");
      const config = { projectDir: TEST_DIR } as any;
      const prompt = buildEvaluatePrompt(config, [], TEST_DIR);
      expect(prompt).not.toContain("## Project Type");
    });
  });

  // ── bootstrap saveProjectType integration ──────────────────────

  describe("bootstrap saveProjectType", () => {
    it("detectProjectType + saveProjectType writes cache file", async () => {
      const { detectProjectType, saveProjectType } = await import("../src/project-type.js");
      // Create a project with CLI signal
      writeFileSync(join(TEST_DIR, "CLAUDE.md"), "# Test\nThis is a CLI tool.");

      const result = detectProjectType(TEST_DIR);
      saveProjectType(TEST_DIR, result);

      const cachePath = join(GARYCLAW_DIR, "project-type.json");
      expect(existsSync(cachePath)).toBe(true);
    });
  });
});
