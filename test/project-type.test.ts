/**
 * Tests for project-type.ts — deterministic project classification.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";

import {
  detectProjectType,
  loadProjectType,
  saveProjectType,
  ensureProjectType,
  formatProjectContext,
} from "../src/project-type.js";
import type { ProjectTypeResult } from "../src/project-type.js";

const TEST_DIR = join(process.cwd(), ".test-project-type-tmp");
const GARYCLAW_DIR = join(TEST_DIR, ".garyclaw");

function setup(opts: {
  claudeMd?: string;
  packageJson?: Record<string, unknown>;
  dirs?: string[];
  files?: string[];
} = {}): void {
  mkdirSync(TEST_DIR, { recursive: true });
  mkdirSync(GARYCLAW_DIR, { recursive: true });

  if (opts.claudeMd !== undefined) {
    writeFileSync(join(TEST_DIR, "CLAUDE.md"), opts.claudeMd);
  }
  if (opts.packageJson !== undefined) {
    writeFileSync(join(TEST_DIR, "package.json"), JSON.stringify(opts.packageJson));
  }
  for (const d of opts.dirs ?? []) {
    mkdirSync(join(TEST_DIR, d), { recursive: true });
  }
  for (const f of opts.files ?? []) {
    mkdirSync(join(TEST_DIR, join(f, "..").replace(TEST_DIR, "")), { recursive: true });
    writeFileSync(join(TEST_DIR, f), "");
  }
}

function cleanup(): void {
  rmSync(TEST_DIR, { recursive: true, force: true });
}

describe("detectProjectType", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  // ── Tier 1: CLAUDE.md keywords ──────────────────────────────

  it("CLI from CLAUDE.md keywords", () => {
    setup({ claudeMd: "# MyCLI\n\nA CLI tool for managing deployments." });
    const result = detectProjectType(TEST_DIR);
    expect(result.type).toBe("cli");
    expect(result.confidence).toBe(0.9);
    expect(result.evidence.some((e) => e.includes("cli tool"))).toBe(true);
  });

  it("web app from CLAUDE.md", () => {
    setup({ claudeMd: "# MyApp\n\nA web application for tracking expenses." });
    const result = detectProjectType(TEST_DIR);
    expect(result.type).toBe("web-app");
    expect(result.confidence).toBe(0.9);
  });

  it("API from CLAUDE.md", () => {
    setup({ claudeMd: "# MyAPI\n\nAn API server for user management." });
    const result = detectProjectType(TEST_DIR);
    expect(result.type).toBe("api");
    expect(result.confidence).toBe(0.9);
  });

  it("library from CLAUDE.md", () => {
    setup({ claudeMd: "# MyLib\n\nA library for parsing markdown." });
    const result = detectProjectType(TEST_DIR);
    expect(result.type).toBe("library");
    expect(result.confidence).toBe(0.9);
  });

  it("case-insensitive CLAUDE.md matching", () => {
    setup({ claudeMd: "# MyTool\n\nA Command-Line Tool for devops." });
    const result = detectProjectType(TEST_DIR);
    expect(result.type).toBe("cli");
    expect(result.confidence).toBe(0.9);
  });

  // ── Tier 2: package.json dependencies ──────────────────────

  it("Next.js from package.json", () => {
    setup({ packageJson: { dependencies: { next: "14.0.0", react: "18.0.0" } } });
    const result = detectProjectType(TEST_DIR);
    expect(result.type).toBe("web-app");
    expect(result.confidence).toBe(0.8);
    expect(result.frameworks).toContain("next");
  });

  it("Express API from package.json (no frontend deps)", () => {
    setup({ packageJson: { dependencies: { express: "4.18.0" } } });
    const result = detectProjectType(TEST_DIR);
    expect(result.type).toBe("api");
    expect(result.confidence).toBe(0.8);
    expect(result.frameworks).toContain("express");
  });

  it("Express with React is web-app (web framework via React SPA)", () => {
    // express + react but no next/nuxt → frontend lib detects as web-app
    // Actually: SERVER_FRAMEWORKS check excludes when hasFrontendLib=true
    // So it falls through to hasFrontendLib → web-app
    setup({ packageJson: { dependencies: { express: "4.18.0", react: "18.0.0" } } });
    const result = detectProjectType(TEST_DIR);
    expect(result.type).toBe("web-app");
    expect(result.confidence).toBe(0.7);
  });

  it("commander CLI from package.json", () => {
    setup({ packageJson: { dependencies: { commander: "11.0.0" } } });
    const result = detectProjectType(TEST_DIR);
    expect(result.type).toBe("cli");
    expect(result.confidence).toBe(0.8);
  });

  it("monorepo from workspaces", () => {
    setup({ packageJson: { workspaces: ["packages/*"] } });
    const result = detectProjectType(TEST_DIR);
    expect(result.type).toBe("monorepo");
    expect(result.confidence).toBe(0.6);
  });

  it("React SPA from package.json (no SSR framework)", () => {
    setup({ packageJson: { dependencies: { react: "18.0.0", "react-dom": "18.0.0" } } });
    const result = detectProjectType(TEST_DIR);
    expect(result.type).toBe("web-app");
    expect(result.confidence).toBe(0.7);
  });

  // ── Tier 3: file patterns ──────────────────────────────────

  it("file pattern fallback: pages/ directory", () => {
    setup({ dirs: ["pages"] });
    const result = detectProjectType(TEST_DIR);
    expect(result.type).toBe("web-app");
    expect(result.confidence).toBe(0.7);
  });

  it("file pattern fallback: src/cli.ts", () => {
    setup({ files: ["src/cli.ts"] });
    const result = detectProjectType(TEST_DIR);
    expect(result.type).toBe("cli");
    expect(result.confidence).toBe(0.6);
  });

  it("file pattern fallback: bin/ directory", () => {
    setup({ dirs: ["bin"] });
    const result = detectProjectType(TEST_DIR);
    expect(result.type).toBe("cli");
    expect(result.confidence).toBe(0.6);
  });

  // ── Unknown / edge cases ───────────────────────────────────

  it("unknown when no signals", () => {
    setup();
    const result = detectProjectType(TEST_DIR);
    expect(result.type).toBe("unknown");
    expect(result.confidence).toBe(0);
    expect(result.evidence).toEqual([]);
  });

  it("CLAUDE.md trumps package.json (Tier 1 > Tier 2)", () => {
    setup({
      claudeMd: "# MyCLI\n\nA CLI tool for web development.",
      packageJson: { dependencies: { react: "18.0.0", "react-dom": "18.0.0" } },
    });
    const result = detectProjectType(TEST_DIR);
    expect(result.type).toBe("cli");
    expect(result.confidence).toBe(0.9);
    // React still appears in frameworks and evidence
    expect(result.frameworks).toContain("react");
    expect(result.evidence.some((e) => e.includes("react"))).toBe(true);
  });

  it("multiple CLAUDE.md signals accumulate evidence", () => {
    setup({
      claudeMd: "# MyCLI\n\nA command-line tool, also known as a CLI tool.",
      packageJson: { dependencies: { commander: "11.0.0" }, scripts: { test: "vitest" } },
    });
    const result = detectProjectType(TEST_DIR);
    expect(result.type).toBe("cli");
    expect(result.confidence).toBe(0.9);
    // Multiple evidence entries
    expect(result.evidence.length).toBeGreaterThanOrEqual(2);
  });

  it("mixed-signal CLAUDE.md: first phrase match wins", () => {
    setup({ claudeMd: "A CLI tool for managing web applications with a REST API." });
    const result = detectProjectType(TEST_DIR);
    expect(result.type).toBe("cli");
  });

  // ── hasWebUI ───────────────────────────────────────────────

  it("hasWebUI: true for web-app", () => {
    setup({ claudeMd: "A web application." });
    const result = detectProjectType(TEST_DIR);
    expect(result.hasWebUI).toBe(true);
  });

  it("hasWebUI: false for cli", () => {
    setup({ claudeMd: "A CLI tool." });
    const result = detectProjectType(TEST_DIR);
    expect(result.hasWebUI).toBe(false);
  });

  it("hasWebUI: true for api with frontend deps", () => {
    setup({
      claudeMd: "An API server with a React dashboard.",
      packageJson: { dependencies: { express: "4.18.0", react: "18.0.0" } },
    });
    const result = detectProjectType(TEST_DIR);
    expect(result.type).toBe("api");
    expect(result.hasWebUI).toBe(true);
  });

  // ── hasTestSuite / testCommand ─────────────────────────────

  it("hasTestSuite: true when scripts.test exists", () => {
    setup({ packageJson: { scripts: { test: "vitest" } } });
    const result = detectProjectType(TEST_DIR);
    expect(result.hasTestSuite).toBe(true);
    expect(result.testCommand).toBe("vitest");
  });

  it("hasTestSuite: false for npm placeholder", () => {
    setup({
      packageJson: { scripts: { test: 'echo "Error: no test specified" && exit 1' } },
    });
    const result = detectProjectType(TEST_DIR);
    expect(result.hasTestSuite).toBe(false);
    expect(result.testCommand).toBeUndefined();
  });

  it("testCommand: extracted from package.json", () => {
    setup({ packageJson: { scripts: { test: "vitest run --reporter verbose" } } });
    const result = detectProjectType(TEST_DIR);
    expect(result.testCommand).toBe("vitest run --reporter verbose");
  });

  it("invalid package.json is handled gracefully", () => {
    setup();
    writeFileSync(join(TEST_DIR, "package.json"), "{ invalid json");
    const result = detectProjectType(TEST_DIR);
    expect(result.type).toBe("unknown");
  });
});

describe("loadProjectType / saveProjectType", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("reads cached file", () => {
    setup();
    const original: ProjectTypeResult = {
      type: "cli",
      confidence: 0.9,
      evidence: ["CLAUDE.md contains \"cli tool\""],
      frameworks: ["commander"],
      hasWebUI: false,
      hasTestSuite: true,
      testCommand: "vitest",
    };
    saveProjectType(TEST_DIR, original);
    const loaded = loadProjectType(TEST_DIR);
    expect(loaded).toEqual(original);
  });

  it("returns null when missing", () => {
    setup();
    const loaded = loadProjectType(TEST_DIR);
    expect(loaded).toBeNull();
  });
});

describe("ensureProjectType", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("detects and caches on first call", () => {
    setup({ claudeMd: "A CLI tool." });
    expect(loadProjectType(TEST_DIR)).toBeNull();
    const result = ensureProjectType(TEST_DIR);
    expect(result.type).toBe("cli");
    // Now cached
    expect(loadProjectType(TEST_DIR)).toEqual(result);
  });

  it("returns cached on second call", () => {
    setup({ claudeMd: "A CLI tool." });
    const first = ensureProjectType(TEST_DIR);
    // Change CLAUDE.md to something different
    writeFileSync(join(TEST_DIR, "CLAUDE.md"), "A web application.");
    const second = ensureProjectType(TEST_DIR);
    // Should still be CLI (cached)
    expect(second.type).toBe("cli");
    expect(second).toEqual(first);
  });

  it("forceRedetect ignores cache", () => {
    setup({ claudeMd: "A CLI tool." });
    ensureProjectType(TEST_DIR);
    // Change CLAUDE.md
    writeFileSync(join(TEST_DIR, "CLAUDE.md"), "A web application.");
    const result = ensureProjectType(TEST_DIR, true);
    expect(result.type).toBe("web-app");
  });
});

describe("formatProjectContext", () => {
  it("compact output under 500 chars", () => {
    const pt: ProjectTypeResult = {
      type: "cli",
      confidence: 0.9,
      evidence: ["CLAUDE.md contains \"cli tool\"", "commander in deps"],
      frameworks: ["commander"],
      hasWebUI: false,
      hasTestSuite: true,
      testCommand: "vitest",
    };
    const formatted = formatProjectContext(pt);
    expect(formatted.length).toBeLessThanOrEqual(500);
    expect(formatted).toContain("CLI tool");
    expect(formatted).toContain("No web UI");
    expect(formatted).toContain("vitest");
  });

  it("unknown type returns empty string", () => {
    const pt: ProjectTypeResult = {
      type: "unknown",
      confidence: 0,
      evidence: [],
      frameworks: [],
      hasWebUI: false,
      hasTestSuite: false,
    };
    expect(formatProjectContext(pt)).toBe("");
  });

  it("web-app shows has web UI", () => {
    const pt: ProjectTypeResult = {
      type: "web-app",
      confidence: 0.8,
      evidence: ["next in deps"],
      frameworks: ["next"],
      hasWebUI: true,
      hasTestSuite: false,
    };
    const formatted = formatProjectContext(pt);
    expect(formatted).toContain("Has web UI");
    expect(formatted).toContain("Web application");
  });

  it("truncates to 500 chars", () => {
    const pt: ProjectTypeResult = {
      type: "cli",
      confidence: 0.9,
      evidence: Array.from({ length: 50 }, (_, i) => `Evidence item ${i} with a long description that adds up`),
      frameworks: [],
      hasWebUI: false,
      hasTestSuite: false,
    };
    const formatted = formatProjectContext(pt);
    expect(formatted.length).toBeLessThanOrEqual(500);
    expect(formatted.endsWith("...")).toBe(true);
  });
});
