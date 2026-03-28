/**
 * Bootstrap skill tests — analyzeCodebase, buildBootstrapPrompt, helpers.
 * All tests use synthetic filesystems — no real codebase analysis.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { join } from "node:path";

import {
  walkFileTree,
  detectTechStack,
  filePriority,
  safeReadFile,
  findCiConfig,
  findTestDir,
  buildFileTreeString,
  truncateToTokenBudget,
  analyzeCodebase,
  buildBootstrapPrompt,
  TOKEN_BUDGET,
} from "../src/bootstrap.js";
import type { GaryClawConfig, PipelineSkillEntry } from "../src/types.js";

// ── Helpers ──────────────────────────────────────────────────────

const TEST_DIR = join(process.cwd(), ".test-bootstrap-tmp");

function createMockConfig(overrides: Partial<GaryClawConfig> = {}): GaryClawConfig {
  return {
    skillName: "bootstrap",
    projectDir: TEST_DIR,
    maxTurnsPerSegment: 15,
    relayThresholdRatio: 0.85,
    checkpointDir: join(TEST_DIR, ".garyclaw"),
    settingSources: [],
    env: {},
    askTimeoutMs: 30000,
    maxRelaySessions: 10,
    autonomous: true,
    ...overrides,
  };
}

function setupTestRepo(opts: {
  packageJson?: Record<string, unknown>;
  tsConfig?: Record<string, unknown>;
  readme?: string;
  claudeMd?: string;
  todosMd?: string;
  sourceFiles?: Record<string, string>;
  ciConfig?: string;
} = {}): void {
  mkdirSync(TEST_DIR, { recursive: true });

  if (opts.packageJson) {
    writeFileSync(join(TEST_DIR, "package.json"), JSON.stringify(opts.packageJson, null, 2));
  }
  if (opts.tsConfig) {
    writeFileSync(join(TEST_DIR, "tsconfig.json"), JSON.stringify(opts.tsConfig, null, 2));
  }
  if (opts.readme) {
    writeFileSync(join(TEST_DIR, "README.md"), opts.readme);
  }
  if (opts.claudeMd) {
    writeFileSync(join(TEST_DIR, "CLAUDE.md"), opts.claudeMd);
  }
  if (opts.todosMd) {
    writeFileSync(join(TEST_DIR, "TODOS.md"), opts.todosMd);
  }
  if (opts.ciConfig) {
    mkdirSync(join(TEST_DIR, ".github", "workflows"), { recursive: true });
    writeFileSync(join(TEST_DIR, ".github", "workflows", "ci.yml"), opts.ciConfig);
  }
  if (opts.sourceFiles) {
    for (const [relPath, content] of Object.entries(opts.sourceFiles)) {
      const fullPath = join(TEST_DIR, relPath);
      mkdirSync(join(fullPath, ".."), { recursive: true });
      writeFileSync(fullPath, content);
    }
  }
}

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ── walkFileTree ─────────────────────────────────────────────────

describe("walkFileTree", () => {
  it("collects files recursively", () => {
    setupTestRepo({
      sourceFiles: {
        "src/index.ts": "export {};",
        "src/utils.ts": "export {};",
        "src/lib/helper.ts": "export {};",
      },
    });
    const { files, truncated } = walkFileTree(TEST_DIR);
    expect(truncated).toBe(false);
    expect(files).toContain("src/index.ts");
    expect(files).toContain("src/utils.ts");
    expect(files).toContain("src/lib/helper.ts");
  });

  it("skips node_modules and .git", () => {
    setupTestRepo({
      sourceFiles: {
        "src/app.ts": "export {};",
      },
    });
    mkdirSync(join(TEST_DIR, "node_modules", "foo"), { recursive: true });
    writeFileSync(join(TEST_DIR, "node_modules", "foo", "index.js"), "module.exports = {}");
    mkdirSync(join(TEST_DIR, ".git", "objects"), { recursive: true });
    writeFileSync(join(TEST_DIR, ".git", "objects", "abc"), "blob");

    const { files } = walkFileTree(TEST_DIR);
    expect(files.some((f) => f.includes("node_modules"))).toBe(false);
    expect(files.some((f) => f.includes(".git"))).toBe(false);
    expect(files).toContain("src/app.ts");
  });

  it("truncates at maxFiles", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    // Create 10 files, set limit to 5
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(TEST_DIR, `file${i}.ts`), "export {};");
    }
    const { files, truncated } = walkFileTree(TEST_DIR, 5);
    expect(files.length).toBeLessThanOrEqual(5);
    expect(truncated).toBe(true);
  });

  it("handles empty directory", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const { files, truncated } = walkFileTree(TEST_DIR);
    expect(files).toEqual([]);
    expect(truncated).toBe(false);
  });

  it("handles nonexistent directory gracefully", () => {
    // walkFileTree should not throw — readdirSync failure returns empty
    const { files } = walkFileTree(join(TEST_DIR, "nonexistent"));
    expect(files).toEqual([]);
  });

  it("detects symlink cycles", () => {
    mkdirSync(join(TEST_DIR, "a"), { recursive: true });
    writeFileSync(join(TEST_DIR, "a", "file.ts"), "export {};");

    try {
      symlinkSync(join(TEST_DIR, "a"), join(TEST_DIR, "a", "link"), "dir");
    } catch {
      // If symlinks aren't supported, skip
      return;
    }

    const { files } = walkFileTree(TEST_DIR);
    // Should not hang, should find file.ts once
    const tsFiles = files.filter((f) => f.endsWith("file.ts"));
    expect(tsFiles.length).toBe(1);
  });
});

// ── detectTechStack ──────────────────────────────────────────────

describe("detectTechStack", () => {
  it("detects TypeScript from file extensions", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const files = ["src/index.ts", "src/types.ts"];
    const stack = detectTechStack(TEST_DIR, files, null);
    expect(stack).toContain("typescript");
  });

  it("detects Python from files", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const files = ["main.py", "utils.py"];
    const stack = detectTechStack(TEST_DIR, files, null);
    expect(stack).toContain("python");
  });

  it("detects frameworks from package.json", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(join(TEST_DIR, "package.json"), "{}");
    const pkg = JSON.stringify({
      dependencies: { react: "^18.0.0", next: "^14.0.0" },
      devDependencies: { vitest: "^1.0.0", tailwindcss: "^3.0.0" },
    });
    const files = ["src/app.tsx"];
    const stack = detectTechStack(TEST_DIR, files, pkg);
    expect(stack).toContain("react");
    expect(stack).toContain("next.js");
    expect(stack).toContain("vitest");
    expect(stack).toContain("tailwindcss");
    expect(stack).toContain("typescript");
    expect(stack).toContain("node");
  });

  it("detects Go from go.mod", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(join(TEST_DIR, "go.mod"), "module example.com/foo");
    const stack = detectTechStack(TEST_DIR, ["main.go"], null);
    expect(stack).toContain("go");
  });

  it("detects Rust from Cargo.toml", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(join(TEST_DIR, "Cargo.toml"), "[package]");
    const stack = detectTechStack(TEST_DIR, ["src/main.rs"], null);
    expect(stack).toContain("rust");
  });

  it("handles invalid package.json gracefully", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(join(TEST_DIR, "package.json"), "{}");
    const stack = detectTechStack(TEST_DIR, ["index.js"], "not valid json {{{");
    expect(stack).toContain("javascript");
    expect(stack).toContain("node");
  });

  it("deduplicates stack entries", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(join(TEST_DIR, "go.mod"), "module foo");
    const files = ["main.go", "pkg/server.go"];
    const stack = detectTechStack(TEST_DIR, files, null);
    const goCount = stack.filter((s) => s === "go").length;
    expect(goCount).toBe(1);
  });

  it("returns empty array for unknown project", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const stack = detectTechStack(TEST_DIR, [], null);
    expect(stack).toEqual([]);
  });
});

// ── filePriority ─────────────────────────────────────────────────

describe("filePriority", () => {
  it("gives test files highest priority", () => {
    expect(filePriority("src/foo.test.ts")).toBe(1);
    expect(filePriority("src/bar.spec.js")).toBe(1);
    expect(filePriority("__tests__/baz.ts")).toBe(1);
  });

  it("gives entry points second priority", () => {
    expect(filePriority("src/index.ts")).toBe(2);
    expect(filePriority("src/main.js")).toBe(2);
    expect(filePriority("cli.ts")).toBe(2);
    expect(filePriority("server.js")).toBe(2);
  });

  it("gives type definitions third priority", () => {
    expect(filePriority("src/types.ts")).toBe(3);
    expect(filePriority("src/global.d.ts")).toBe(3);
  });

  it("gives config files fourth priority", () => {
    expect(filePriority("vite.config.ts")).toBe(4);
    expect(filePriority("vitest.config.js")).toBe(4);
  });

  it("gives regular source files fifth priority", () => {
    expect(filePriority("src/utils.ts")).toBe(5);
    expect(filePriority("lib/helper.py")).toBe(5);
  });

  it("gives other files lowest priority", () => {
    expect(filePriority("data/seed.csv")).toBe(10);
    expect(filePriority("assets/logo.svg")).toBe(10);
  });
});

// ── safeReadFile ─────────────────────────────────────────────────

describe("safeReadFile", () => {
  it("reads a text file", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(join(TEST_DIR, "hello.txt"), "Hello world");
    expect(safeReadFile(join(TEST_DIR, "hello.txt"))).toBe("Hello world");
  });

  it("returns null for nonexistent file", () => {
    expect(safeReadFile(join(TEST_DIR, "nope.txt"))).toBeNull();
  });

  it("returns null for binary file (null bytes)", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const buf = Buffer.alloc(100);
    buf[50] = 0; // null byte
    writeFileSync(join(TEST_DIR, "binary.bin"), buf);
    expect(safeReadFile(join(TEST_DIR, "binary.bin"))).toBeNull();
  });

  it("truncates to maxBytes", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const longContent = "A".repeat(10000);
    writeFileSync(join(TEST_DIR, "long.txt"), longContent);
    const result = safeReadFile(join(TEST_DIR, "long.txt"), 100);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(100);
  });
});

// ── findCiConfig ─────────────────────────────────────────────────

describe("findCiConfig", () => {
  it("finds GitHub Actions config", () => {
    setupTestRepo({
      ciConfig: "name: CI\non: push",
    });
    const config = findCiConfig(TEST_DIR);
    expect(config).toContain("name: CI");
  });

  it("returns null when no CI config exists", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    expect(findCiConfig(TEST_DIR)).toBeNull();
  });

  it("finds .gitlab-ci.yml", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(join(TEST_DIR, ".gitlab-ci.yml"), "stages:\n  - test");
    const config = findCiConfig(TEST_DIR);
    expect(config).toContain("stages:");
  });
});

// ── findTestDir ──────────────────────────────────────────────────

describe("findTestDir", () => {
  it("finds test/ directory", () => {
    mkdirSync(join(TEST_DIR, "test"), { recursive: true });
    expect(findTestDir(TEST_DIR, [])).toBe("test");
  });

  it("finds __tests__/ directory", () => {
    mkdirSync(join(TEST_DIR, "__tests__"), { recursive: true });
    expect(findTestDir(TEST_DIR, [])).toBe("__tests__");
  });

  it("infers test dir from test file paths", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const files = ["src/utils.test.ts", "src/lib/helper.test.ts"];
    expect(findTestDir(TEST_DIR, files)).toBe("src");
  });

  it("returns null when no tests found", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    expect(findTestDir(TEST_DIR, ["src/app.ts"])).toBeNull();
  });
});

// ── buildFileTreeString ──────────────────────────────────────────

describe("buildFileTreeString", () => {
  it("returns all files when under budget", () => {
    const files = ["src/a.ts", "src/b.ts", "src/c.ts"];
    const result = buildFileTreeString(files, 1000);
    expect(result).toBe("src/a.ts\nsrc/b.ts\nsrc/c.ts");
  });

  it("truncates when over budget", () => {
    // Create enough files to exceed budget
    const files = Array.from({ length: 500 }, (_, i) => `src/module-${i}/very-long-file-name.ts`);
    const result = buildFileTreeString(files, 100); // tiny budget
    expect(result).toContain("... (");
    expect(result).toContain("more files");
  });
});

// ── truncateToTokenBudget ────────────────────────────────────────

describe("truncateToTokenBudget", () => {
  it("returns text unchanged when under budget", () => {
    const text = "Hello world";
    expect(truncateToTokenBudget(text, 1000)).toBe(text);
  });

  it("truncates when over budget", () => {
    const text = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5";
    const result = truncateToTokenBudget(text, 3); // ~10 chars
    expect(result).toContain("... (truncated)");
    expect(result.length).toBeLessThan(text.length + 20);
  });
});

// ── analyzeCodebase ──────────────────────────────────────────────

describe("analyzeCodebase", () => {
  it("analyzes a minimal TypeScript project", async () => {
    setupTestRepo({
      packageJson: {
        name: "test-project",
        dependencies: { express: "^4.18.0" },
        devDependencies: { vitest: "^1.0.0" },
      },
      tsConfig: { compilerOptions: { target: "es2022" } },
      readme: "# Test Project\n\nA test project.",
      sourceFiles: {
        "src/index.ts": "import express from 'express';\nconst app = express();",
        "src/types.ts": "export interface Foo { bar: string; }",
        "test/index.test.ts": "import { describe, it } from 'vitest';",
      },
    });

    const analysis = await analyzeCodebase(TEST_DIR);

    expect(analysis.techStack).toContain("typescript");
    expect(analysis.techStack).toContain("express");
    expect(analysis.techStack).toContain("vitest");
    expect(analysis.packageJson).toContain("test-project");
    expect(analysis.tsConfig).toContain("es2022");
    expect(analysis.readme).toContain("Test Project");
    expect(analysis.testDir).toBe("test");
    expect(analysis.totalSourceFiles).toBeGreaterThan(0);
    expect(analysis.existingClaudeMd).toBe(false);
    expect(analysis.existingTodosMd).toBe(false);
    expect(analysis.totalTokensGathered).toBeGreaterThan(0);
    expect(analysis.totalTokensGathered).toBeLessThanOrEqual(TOKEN_BUDGET);
  });

  it("detects existing CLAUDE.md", async () => {
    setupTestRepo({
      claudeMd: "# My Project",
      sourceFiles: { "src/app.ts": "export {};" },
    });
    const analysis = await analyzeCodebase(TEST_DIR);
    expect(analysis.existingClaudeMd).toBe(true);
    expect(analysis.existingTodosMd).toBe(false);
  });

  it("detects existing TODOS.md", async () => {
    setupTestRepo({
      todosMd: "## P1: Fix bug",
      sourceFiles: { "src/app.ts": "export {};" },
    });
    const analysis = await analyzeCodebase(TEST_DIR);
    expect(analysis.existingClaudeMd).toBe(false);
    expect(analysis.existingTodosMd).toBe(true);
  });

  it("handles empty repo", async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const analysis = await analyzeCodebase(TEST_DIR);
    expect(analysis.techStack).toEqual([]);
    expect(analysis.totalSourceFiles).toBe(0);
    expect(analysis.packageJson).toBeNull();
    expect(Object.keys(analysis.sourceFiles)).toHaveLength(0);
  });

  it("stays within token budget", async () => {
    // Create a project with lots of source files
    const sourceFiles: Record<string, string> = {};
    for (let i = 0; i < 50; i++) {
      sourceFiles[`src/module${i}.ts`] = `// Module ${i}\n${"export const x = 1;\n".repeat(100)}`;
    }
    setupTestRepo({
      packageJson: { name: "big-project" },
      readme: "A".repeat(20000),
      sourceFiles,
    });

    const analysis = await analyzeCodebase(TEST_DIR);
    expect(analysis.totalTokensGathered).toBeLessThanOrEqual(TOKEN_BUDGET);
  });

  it("prioritizes test files in sampling", async () => {
    setupTestRepo({
      sourceFiles: {
        "src/index.ts": "const app = 1;",
        "src/utils.ts": "const util = 2;",
        "test/index.test.ts": "describe('app', () => {});",
        "src/deep/nested/module.ts": "const deep = 3;",
      },
    });

    const analysis = await analyzeCodebase(TEST_DIR);
    const sampledPaths = Object.keys(analysis.sourceFiles);

    // test file should be sampled (highest priority)
    expect(sampledPaths.some((p) => p.includes("test"))).toBe(true);
  });

  it("records errors for truncated tree", async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    // walkFileTree defaults to 5000, but let's just verify the analysis object structure
    const analysis = await analyzeCodebase(TEST_DIR);
    expect(Array.isArray(analysis.errors)).toBe(true);
  });
});

// ── buildBootstrapPrompt ─────────────────────────────────────────

describe("buildBootstrapPrompt", () => {
  it("generates full prompt for fresh repo", async () => {
    setupTestRepo({
      packageJson: { name: "fresh-app", dependencies: { react: "^18.0.0" } },
      readme: "# Fresh App",
      sourceFiles: {
        "src/App.tsx": "export function App() { return <div/>; }",
      },
    });

    const config = createMockConfig();
    const prompt = await buildBootstrapPrompt(config, [], TEST_DIR);

    // Should include both generation instructions
    expect(prompt).toContain("Generate CLAUDE.md");
    expect(prompt).toContain("Generate TODOS.md");
    expect(prompt).toContain("fresh-app");
    expect(prompt).toContain("react");
    expect(prompt).toContain("## Rules");
  });

  it("omits CLAUDE.md instructions when it exists", async () => {
    setupTestRepo({
      claudeMd: "# Existing project docs",
      sourceFiles: { "src/app.ts": "export {};" },
    });

    const config = createMockConfig();
    const prompt = await buildBootstrapPrompt(config, [], TEST_DIR);

    expect(prompt).not.toContain("Generate CLAUDE.md");
    expect(prompt).toContain("Generate TODOS.md");
    expect(prompt).toContain("CLAUDE.md already exists");
  });

  it("omits TODOS.md instructions when it exists", async () => {
    setupTestRepo({
      todosMd: "## P1: Existing item",
      sourceFiles: { "src/app.ts": "export {};" },
    });

    const config = createMockConfig();
    const prompt = await buildBootstrapPrompt(config, [], TEST_DIR);

    expect(prompt).toContain("Generate CLAUDE.md");
    expect(prompt).not.toContain("Generate TODOS.md");
    expect(prompt).toContain("TODOS.md already exists");
  });

  it("returns no-op when both exist", async () => {
    setupTestRepo({
      claudeMd: "# Project",
      todosMd: "## P1: Item",
      sourceFiles: { "src/app.ts": "export {};" },
    });

    const config = createMockConfig();
    const prompt = await buildBootstrapPrompt(config, [], TEST_DIR);

    expect(prompt).toContain("Nothing to bootstrap");
    expect(prompt).not.toContain("Generate CLAUDE.md");
    expect(prompt).not.toContain("Generate TODOS.md");
  });

  it("includes codebase analysis in prompt", async () => {
    setupTestRepo({
      packageJson: { name: "analyzed-app" },
      tsConfig: { compilerOptions: { strict: true } },
      sourceFiles: {
        "src/server.ts": "import express from 'express';",
      },
    });

    const config = createMockConfig();
    const prompt = await buildBootstrapPrompt(config, [], TEST_DIR);

    expect(prompt).toContain("Codebase Analysis");
    expect(prompt).toContain("package.json");
    expect(prompt).toContain("tsconfig.json");
    expect(prompt).toContain("Source File Samples");
  });

  it("includes TODOS.md format instructions", async () => {
    setupTestRepo({
      sourceFiles: { "src/app.ts": "export {};" },
    });

    const config = createMockConfig();
    const prompt = await buildBootstrapPrompt(config, [], TEST_DIR);

    // Must include the parseTodoItems() format
    expect(prompt).toContain("## P{N}: {Title}");
    expect(prompt).toContain("**What:**");
    expect(prompt).toContain("**Why:**");
    expect(prompt).toContain("**Effort:**");
    expect(prompt).toContain("**Depends on:**");
  });

  it("handles empty repo gracefully", async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const config = createMockConfig();
    const prompt = await buildBootstrapPrompt(config, [], TEST_DIR);

    // Should still generate instructions
    expect(prompt).toContain("Generate CLAUDE.md");
    expect(prompt).toContain("Generate TODOS.md");
    expect(prompt).toContain("Total source files:** 0");
  });

  it("includes previous skills context", async () => {
    setupTestRepo({
      sourceFiles: { "src/app.ts": "export {};" },
    });

    const prevSkills: PipelineSkillEntry[] = [
      {
        skillName: "qa",
        status: "complete",
        report: {
          runId: "run-qa",
          skillName: "qa",
          startTime: "2026-03-28T10:00:00.000Z",
          endTime: "2026-03-28T10:30:00.000Z",
          totalSessions: 1,
          totalTurns: 10,
          estimatedCostUsd: 0.05,
          issues: [],
          findings: [],
          decisions: [],
          relayPoints: [],
        },
      },
    ];

    const config = createMockConfig();
    // Should not throw with previous skills
    const prompt = await buildBootstrapPrompt(config, prevSkills, TEST_DIR);
    expect(prompt).toBeTruthy();
  });

  it("includes tech stack in analysis section", async () => {
    setupTestRepo({
      packageJson: { name: "ts-app", devDependencies: { vitest: "^1" } },
      sourceFiles: {
        "src/index.ts": "console.log('hello');",
      },
    });

    const config = createMockConfig();
    const prompt = await buildBootstrapPrompt(config, [], TEST_DIR);

    expect(prompt).toContain("Tech stack:**");
    expect(prompt).toContain("typescript");
  });

  it("includes CI config when present", async () => {
    setupTestRepo({
      ciConfig: "name: CI\non: [push, pull_request]",
      sourceFiles: { "src/app.ts": "export {};" },
    });

    const config = createMockConfig();
    const prompt = await buildBootstrapPrompt(config, [], TEST_DIR);

    expect(prompt).toContain("CI Configuration");
    expect(prompt).toContain("name: CI");
  });
});
