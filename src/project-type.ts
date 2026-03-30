/**
 * Project Type Awareness — deterministic project classification from on-disk signals.
 *
 * Detects project type (cli, web-app, api, library, monorepo, unknown) from
 * CLAUDE.md keywords, package.json dependencies, and file patterns.
 * Results cached in `.garyclaw/project-type.json` for instant reuse across skills.
 *
 * Zero LLM calls. Detection takes <50ms on warm filesystem.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { safeReadJSON, safeWriteJSON } from "./safe-json.js";

// ── Types ────────────────────────────────────────────────────────

export type ProjectType = "cli" | "web-app" | "api" | "library" | "monorepo" | "unknown";

export interface ProjectTypeResult {
  type: ProjectType;
  confidence: number;        // 0-1
  evidence: string[];        // human-readable reasons
  frameworks: string[];      // detected frameworks (next, express, commander, etc.)
  hasWebUI: boolean;         // shortcut for skills: "should I open a browser?"
  hasTestSuite: boolean;     // shortcut for QA: "can I run npm test?"
  testCommand?: string;      // detected test command from package.json scripts
}

// ── Constants ────────────────────────────────────────────────────

const CACHE_FILE = "project-type.json";
const GARYCLAW_DIR = ".garyclaw";

/** NPM test placeholder — not a real test command. */
const NPM_TEST_PLACEHOLDER = 'echo "Error: no test specified" && exit 1';

// ── Tier 1: CLAUDE.md keyword signals ────────────────────────────

interface Signal {
  phrases: string[];
  type: ProjectType;
  confidence: number;
}

const TIER1_SIGNALS: Signal[] = [
  { phrases: ["cli tool", "command-line tool", "command line"], type: "cli", confidence: 0.9 },
  { phrases: ["web app", "web application", "frontend application"], type: "web-app", confidence: 0.9 },
  { phrases: ["api server", "rest api", "graphql api"], type: "api", confidence: 0.9 },
  { phrases: ["library", "sdk", "npm package"], type: "library", confidence: 0.9 },
];

// ── Tier 2: package.json dependency signals ──────────────────────

const WEB_FRAMEWORKS = new Set(["next", "nuxt", "remix", "@sveltejs/kit"]);
const SERVER_FRAMEWORKS = new Set(["express", "fastify", "hono", "koa"]);
const CLI_FRAMEWORKS = new Set(["commander", "yargs", "inquirer", "oclif"]);
const FRONTEND_LIBS = new Set(["react", "vue", "svelte", "angular", "@angular/core"]);

// ── Detection ────────────────────────────────────────────────────

/**
 * Detect project type from on-disk signals using a tiered priority system.
 * Tier 1 (CLAUDE.md keywords) > Tier 2 (package.json deps) > Tier 3 (file patterns).
 */
export function detectProjectType(projectDir: string): ProjectTypeResult {
  const evidence: string[] = [];
  const frameworks: string[] = [];
  let type: ProjectType = "unknown";
  let confidence = 0;

  // Read inputs
  const claudeMd = readFileSafe(join(projectDir, "CLAUDE.md"));
  const packageJsonRaw = readFileSafe(join(projectDir, "package.json"));
  let pkg: Record<string, unknown> | null = null;
  let allDeps: Record<string, string> = {};

  if (packageJsonRaw) {
    try {
      pkg = JSON.parse(packageJsonRaw);
      allDeps = {
        ...(pkg?.dependencies as Record<string, string> ?? {}),
        ...(pkg?.devDependencies as Record<string, string> ?? {}),
      };
    } catch {
      // Invalid JSON — skip package.json analysis
    }
  }

  // ── Tier 1: CLAUDE.md keywords ──────────────────────────────
  if (claudeMd) {
    const lower = claudeMd.toLowerCase();
    for (const signal of TIER1_SIGNALS) {
      for (const phrase of signal.phrases) {
        if (lower.includes(phrase)) {
          if (type === "unknown") {
            type = signal.type;
            confidence = signal.confidence;
          }
          evidence.push(`CLAUDE.md contains "${phrase}"`);
          break; // only count first matching phrase per signal
        }
      }
    }
  }

  // Collect framework names from deps (always, for evidence + frameworks array)
  for (const dep of Object.keys(allDeps)) {
    if (WEB_FRAMEWORKS.has(dep)) frameworks.push(dep);
    if (SERVER_FRAMEWORKS.has(dep)) frameworks.push(dep);
    if (CLI_FRAMEWORKS.has(dep)) frameworks.push(dep);
    if (FRONTEND_LIBS.has(dep)) frameworks.push(dep);
  }

  // ── Tier 2: package.json dependencies (only if Tier 1 didn't set type) ──
  if (type === "unknown" && pkg) {
    const hasWebFramework = [...WEB_FRAMEWORKS].some((f) => f in allDeps);
    const hasServerFramework = [...SERVER_FRAMEWORKS].some((f) => f in allDeps);
    const hasCliFramework = [...CLI_FRAMEWORKS].some((f) => f in allDeps);
    const hasFrontendLib = [...FRONTEND_LIBS].some((f) => f in allDeps);

    if (hasWebFramework) {
      type = "web-app";
      confidence = 0.8;
      evidence.push(`Web framework in deps: ${frameworks.filter((f) => WEB_FRAMEWORKS.has(f)).join(", ")}`);
    } else if (hasServerFramework && !hasFrontendLib) {
      type = "api";
      confidence = 0.8;
      evidence.push(`Server framework in deps: ${frameworks.filter((f) => SERVER_FRAMEWORKS.has(f)).join(", ")}`);
    } else if (hasCliFramework) {
      type = "cli";
      confidence = 0.8;
      evidence.push(`CLI framework in deps: ${frameworks.filter((f) => CLI_FRAMEWORKS.has(f)).join(", ")}`);
    } else if (hasFrontendLib) {
      type = "web-app";
      confidence = 0.7;
      evidence.push(`Frontend library in deps: ${frameworks.filter((f) => FRONTEND_LIBS.has(f)).join(", ")}`);
    }

    // Monorepo: workspaces field
    if (type === "unknown" && pkg && ("workspaces" in (pkg as Record<string, unknown>))) {
      type = "monorepo";
      confidence = 0.6;
      evidence.push("package.json has workspaces field");
    }
  } else if (type !== "unknown" && frameworks.length > 0) {
    // Tier 1 won but note deps as additional evidence
    evidence.push(`Detected frameworks: ${frameworks.join(", ")}`);
  }

  // ── Tier 3: file patterns (only if Tiers 1 and 2 didn't set type) ──
  if (type === "unknown") {
    if (dirExists(join(projectDir, "pages")) || dirExists(join(projectDir, "app"))) {
      type = "web-app";
      confidence = 0.7;
      evidence.push("pages/ or app/ directory exists");
    } else if (
      existsSync(join(projectDir, "src", "cli.ts")) ||
      existsSync(join(projectDir, "src", "cli.js")) ||
      dirExists(join(projectDir, "bin"))
    ) {
      type = "cli";
      confidence = 0.6;
      evidence.push("src/cli.ts or bin/ directory exists");
    }
  }

  // ── Derived fields ──────────────────────────────────────────
  const hasWebUI =
    type === "web-app" ||
    (type === "api" && [...FRONTEND_LIBS].some((f) => f in allDeps));

  // Test suite detection
  const scripts = pkg?.scripts as Record<string, string> | undefined;
  const rawTestCmd = scripts?.test;
  const hasTestSuite = typeof rawTestCmd === "string" && rawTestCmd !== NPM_TEST_PLACEHOLDER;
  const testCommand = hasTestSuite ? rawTestCmd : undefined;

  if (hasTestSuite) {
    evidence.push(`Test command: ${testCommand}`);
  }

  return {
    type,
    confidence,
    evidence,
    frameworks,
    hasWebUI,
    hasTestSuite,
    testCommand,
  };
}

// ── Persistence ──────────────────────────────────────────────────

/** Read cached project type from `.garyclaw/project-type.json`. Returns null if missing. */
export function loadProjectType(projectDir: string): ProjectTypeResult | null {
  const filePath = join(projectDir, GARYCLAW_DIR, CACHE_FILE);
  return safeReadJSON<ProjectTypeResult>(filePath);
}

/** Write project type result to `.garyclaw/project-type.json` via atomic write. */
export function saveProjectType(projectDir: string, result: ProjectTypeResult): void {
  const filePath = join(projectDir, GARYCLAW_DIR, CACHE_FILE);
  safeWriteJSON(filePath, result);
}

/**
 * Main entry point: load cached result, detect if missing, save, return.
 * Pass `forceRedetect: true` to ignore cache and re-run detection.
 */
export function ensureProjectType(projectDir: string, forceRedetect?: boolean): ProjectTypeResult {
  if (!forceRedetect) {
    const cached = loadProjectType(projectDir);
    if (cached) return cached;
  }

  const result = detectProjectType(projectDir);
  try {
    saveProjectType(projectDir, result);
  } catch {
    // Cache write failed — return result without caching (fail-open)
  }
  return result;
}

// ── Formatting ───────────────────────────────────────────────────

/**
 * Format project type result as a compact string for Oracle projectContext.
 * Returns empty string for unknown type (no point injecting "we don't know").
 */
export function formatProjectContext(pt: ProjectTypeResult): string {
  if (pt.type === "unknown") return "";

  const typeLabel = pt.type === "web-app" ? "Web application" :
    pt.type === "api" ? "API server" :
    pt.type === "cli" ? "CLI tool" :
    pt.type === "library" ? "Library/SDK" :
    pt.type === "monorepo" ? "Monorepo" : pt.type;

  const parts: string[] = [
    `${typeLabel} (confidence: ${pt.confidence})`,
  ];

  if (pt.hasWebUI) {
    parts.push("Has web UI");
  } else {
    parts.push("No web UI");
  }

  if (pt.hasTestSuite && pt.testCommand) {
    parts.push(`Test suite: ${pt.testCommand}`);
  } else if (!pt.hasTestSuite) {
    parts.push("No test suite detected");
  }

  if (pt.evidence.length > 0) {
    parts.push(`Evidence: ${pt.evidence.join("; ")}`);
  }

  const result = parts.join(". ") + ".";
  // Cap at 500 chars (existing Oracle truncation budget)
  return result.length > 500 ? result.slice(0, 497) + "..." : result;
}

/**
 * Build a `## Project Type` markdown section for prompt injection.
 * Shared by implement, prioritize, and evaluate prompt builders.
 * Returns empty string for unknown type or on detection error (fail-open).
 */
export function buildProjectTypeSection(projectDir: string): string {
  try {
    const pt = ensureProjectType(projectDir);
    if (pt.type === "unknown") return "";
    return `## Project Type\n\n${formatProjectContext(pt)}\n`;
  } catch {
    return "";
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function readFileSafe(filePath: string): string | null {
  try {
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function dirExists(dirPath: string): boolean {
  try {
    return existsSync(dirPath) && statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}
