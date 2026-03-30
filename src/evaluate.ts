/**
 * Evaluate skill — post-dogfood evaluation and GaryClaw improvement extraction.
 *
 * Runs after the dogfood pipeline (bootstrap → prioritize → implement → qa → evaluate),
 * reads all .garyclaw/ artifacts from the target repo, and produces a structured
 * campaign report + GaryClaw improvement candidates.
 *
 * Follows the implement.ts / prioritize.ts pattern: pure functions that build
 * a prompt string, dispatched from pipeline.ts via runSkillWithPrompt().
 */

import { join } from "node:path";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdirSync, unlinkSync } from "node:fs";

import { estimateTokens } from "./checkpoint.js";
import { safeReadJSON, safeReadText, safeWriteJSON, safeWriteText } from "./safe-json.js";
import { groupDecisionsByTopic, DEFAULT_AUTO_RESEARCH_CONFIG } from "./auto-research.js";
import { normalizedLevenshtein } from "./reflection.js";
import { computeGrowthRate } from "./token-monitor.js";
import { buildProjectTypeSection } from "./project-type.js";

import type {
  Decision,
  PipelineSkillEntry,
  PipelineState,
  GaryClawConfig,
  EvaluationReport,
  BootstrapEvaluation,
  OracleEvaluation,
  PipelineEvaluation,
  ImprovementCandidate,
  ImprovementPriority,
  ImprovementEffort,
  ImprovementCategory,
  TokenMonitorState,
  ClaudeMdClaim,
} from "./types.js";

// ── Constants ────────────────────────────────────────────────────

/** Expected sections in a well-formed CLAUDE.md */
export const EXPECTED_SECTIONS = ["Architecture", "Tech Stack", "Test Strategy", "Usage"];

/** Minimum bootstrap quality score (0-100) to proceed without enrichment */
export const BOOTSTRAP_QUALITY_THRESHOLD = 50;

/** Canonical framework names → dependency package names (case-insensitive match) */
export const KNOWN_FRAMEWORKS: ReadonlyMap<string, readonly string[]> = new Map([
  ["React", ["react", "react-dom", "@types/react"]],
  ["Next.js", ["next", "@next/font", "next-auth"]],
  ["Vitest", ["vitest", "@vitest/coverage-v8"]],
  ["Jest", ["jest", "@types/jest", "ts-jest"]],
  ["Express", ["express", "@types/express"]],
  ["Supabase", ["@supabase/supabase-js", "@supabase/ssr"]],
  ["Tailwind CSS", ["tailwindcss", "@tailwindcss/forms", "@tailwindcss/typography"]],
  ["Prisma", ["prisma", "@prisma/client"]],
  ["Vue", ["vue", "@vue/compiler-sfc"]],
  ["Angular", ["@angular/core", "@angular/cli"]],
  ["Svelte", ["svelte", "@sveltejs/kit"]],
  ["Nuxt", ["nuxt", "@nuxt/kit"]],
  ["Fastify", ["fastify"]],
  ["Koa", ["koa", "@types/koa"]],
  ["Hono", ["hono"]],
  ["Drizzle", ["drizzle-orm", "drizzle-kit"]],
  ["TypeORM", ["typeorm"]],
  ["Sequelize", ["sequelize"]],
  ["Mongoose", ["mongoose"]],
  ["Stripe", ["stripe", "@stripe/stripe-js"]],
  ["Auth.js", ["next-auth", "@auth/core"]],
  ["Clerk", ["@clerk/nextjs", "@clerk/clerk-sdk-node"]],
  ["tRPC", ["@trpc/server", "@trpc/client"]],
  ["Zod", ["zod"]],
  ["Playwright", ["playwright", "@playwright/test"]],
  ["Cypress", ["cypress"]],
  ["Storybook", ["storybook", "@storybook/react"]],
  ["ESLint", ["eslint", "@typescript-eslint/parser"]],
  ["Prettier", ["prettier"]],
  ["Mocha", ["mocha", "@types/mocha"]],
  ["Socket.IO", ["socket.io", "socket.io-client"]],
  ["GraphQL", ["graphql", "@apollo/client", "apollo-server"]],
  ["Docker", ["dockerode"]],
  ["Redis", ["redis", "ioredis"]],
  // Supabase, Prisma, Drizzle all connect to PostgreSQL internally.
  // Only packages with observed real-world false negatives are added.
  ["PostgreSQL", ["pg", "@types/pg", "@supabase/supabase-js", "@prisma/client", "prisma", "drizzle-orm"]],
  ["SQLite", ["better-sqlite3", "sqlite3"]],
  ["MongoDB", ["mongodb"]],
  ["Vite", ["vite"]],
  ["Webpack", ["webpack", "webpack-cli"]],
  ["Turbopack", ["@vercel/turbopack"]],
  ["Tauri", ["@tauri-apps/api", "@tauri-apps/cli"]],
  ["Electron", ["electron"]],
]);

// ── Token efficiency scoring ──────────────────────────────────────

/** Score token efficiency: 10 if 2K-10K, 5 if 1K-2K or 10K-20K, 0 otherwise */
export function scoreTokenEfficiency(tokens: number): number {
  if (tokens >= 2_000 && tokens <= 10_000) return 10;
  if ((tokens >= 1_000 && tokens < 2_000) || (tokens > 10_000 && tokens <= 20_000)) return 5;
  return 0;
}

// ── Dependency extraction ────────────────────────────────────────

/**
 * Extract dependency names from package.json content.
 * Returns lowercased dependency names from all dependency fields.
 */
export function extractDependencies(packageJsonContent: string): string[] {
  try {
    const pkg = JSON.parse(packageJsonContent);
    const deps = new Set<string>();
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      if (pkg[field] && typeof pkg[field] === "object") {
        for (const name of Object.keys(pkg[field])) {
          deps.add(name.toLowerCase());
        }
      }
    }
    return Array.from(deps);
  } catch {
    return [];
  }
}

/**
 * Compute framework coverage: how many known frameworks in deps are mentioned in CLAUDE.md.
 * Returns { mentioned, total, coverage } where coverage is 0-1.
 */
export function computeFrameworkCoverage(
  deps: string[],
  claudeMdContent: string,
): { mentioned: number; total: number; coverage: number } {
  const lowerContent = claudeMdContent.toLowerCase();
  const depSet = new Set(deps.map((d) => d.toLowerCase()));

  let mentioned = 0;
  let total = 0;

  for (const [frameworkName, packageNames] of KNOWN_FRAMEWORKS) {
    // Check if any of the framework's packages are in deps
    const inDeps = packageNames.some((pkg) => depSet.has(pkg.toLowerCase()));
    if (!inDeps) continue;

    total++;
    // Check if the framework name is mentioned in CLAUDE.md (case-insensitive)
    if (lowerContent.includes(frameworkName.toLowerCase())) {
      mentioned++;
    }
  }

  return {
    mentioned,
    total,
    coverage: total > 0 ? mentioned / total : 1, // No known frameworks = full coverage
  };
}

// ── Section detection ────────────────────────────────────────────

/**
 * Detect which expected sections exist in CLAUDE.md content.
 * Matches headings (## or ###) containing the section keyword.
 */
export function detectSections(
  content: string,
  expectedSections: string[] = EXPECTED_SECTIONS,
): { found: string[]; missing: string[] } {
  const lowerContent = content.toLowerCase();
  const found: string[] = [];
  const missing: string[] = [];

  for (const section of expectedSections) {
    // Match heading lines containing the section keyword
    const pattern = new RegExp(`^#{1,4}\\s+.*${section.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m");
    if (pattern.test(lowerContent)) {
      found.push(section);
    } else {
      missing.push(section);
    }
  }

  return { found, missing };
}

// ── Claim extraction ──────────────────────────────────────────────

/** Words near a tech name that indicate comparison/negation context (not a usage claim). */
const NEGATION_CONTEXT_WORDS = ["considered", "alternative", "instead of", "not using", "replaced", "migrated from"];

/** Patterns that indicate an install instruction code block (skip these). */
const INSTALL_BLOCK_PREFIXES = ["npm install", "pip install", "brew install", "cargo add", "yarn add", "pnpm add"];

/** Test runner names and their verification signals. */
const TEST_RUNNERS: ReadonlyMap<string, { packages: string[]; configFiles: string[] }> = new Map([
  ["vitest", { packages: ["vitest"], configFiles: ["vitest.config.ts", "vitest.config.js", "vitest.config.mts"] }],
  ["jest", { packages: ["jest", "ts-jest"], configFiles: ["jest.config.ts", "jest.config.js", "jest.config.mjs"] }],
  ["mocha", { packages: ["mocha"], configFiles: [".mocharc.yml", ".mocharc.json"] }],
  ["pytest", { packages: ["pytest"], configFiles: ["pytest.ini", "pyproject.toml", "setup.cfg"] }],
  ["go test", { packages: [], configFiles: ["go.mod"] }],
]);

/**
 * Check if a line is inside a fenced code block that looks like a tree listing.
 * A fenced block is a tree listing if >50% of its non-empty lines match
 * tree drawing characters or indented filenames.
 */
function isTreeListingBlock(block: string): boolean {
  const lines = block.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return false;

  const treePattern = /^\s*[├└│─┬┼╠╚║╟╞]\s/;
  const indentedFilePattern = /^\s{2,}\S+\.\w+$/;
  const treeLines = lines.filter((l) => treePattern.test(l) || indentedFilePattern.test(l));

  return treeLines.length / lines.length > 0.5;
}

/**
 * Extract fenced code blocks from markdown content.
 * Returns array of { start, end, content, isInstall, isTreeListing }.
 */
function extractFencedBlocks(content: string): Array<{
  start: number;
  end: number;
  content: string;
  isInstall: boolean;
  isTreeListing: boolean;
}> {
  const blocks: Array<{ start: number; end: number; content: string; isInstall: boolean; isTreeListing: boolean }> = [];
  const fenceRegex = /^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^\1/gm;

  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(content)) !== null) {
    const blockContent = match[2] ?? "";
    const firstLine = blockContent.trim().split("\n")[0] ?? "";
    const isInstall = INSTALL_BLOCK_PREFIXES.some((p) => firstLine.toLowerCase().startsWith(p));
    const isTreeListing = isTreeListingBlock(blockContent);

    blocks.push({
      start: match.index,
      end: match.index + match[0].length,
      content: blockContent,
      isInstall,
      isTreeListing,
    });
  }

  return blocks;
}

/**
 * Check if a position in the content falls inside any fenced code block.
 */
function isInsideFencedBlock(
  position: number,
  blocks: Array<{ start: number; end: number }>,
): boolean {
  return blocks.some((b) => position >= b.start && position < b.end);
}

/**
 * Check if a tech name appears near negation context words.
 * Looks within ~20 words before and after the match.
 */
function isNegationContext(content: string, matchIndex: number, matchLength: number): boolean {
  // Get ~100 chars before and after (approx 20 words)
  const windowStart = Math.max(0, matchIndex - 100);
  const windowEnd = Math.min(content.length, matchIndex + matchLength + 100);
  const window = content.slice(windowStart, windowEnd).toLowerCase();

  return NEGATION_CONTEXT_WORDS.some((word) => window.includes(word));
}

/**
 * Extract factual claims from CLAUDE.md content.
 *
 * Extracts six types of claims:
 * - tech_stack: Framework/library names from KNOWN_FRAMEWORKS
 * - file_path: File paths matching src/..., lib/..., test/..., app/... patterns
 * - test_framework: Test runner mentions (vitest, jest, mocha, pytest, go test)
 * - entry_point: File paths near "entry point", "main file", "starts at" patterns
 * - command: npm/yarn/pnpm/bun scripts and file-based commands from code blocks
 * - test_directory: Test directory mentions and test file count claims
 *
 * Skips claims inside install instruction code blocks, tree listings,
 * and negation/comparison contexts.
 */
export function extractClaudeMdClaims(claudeMdContent: string): ClaudeMdClaim[] {
  const claims: ClaudeMdClaim[] = [];
  const seenClaims = new Set<string>(); // dedup key: `${type}:${claimed}`

  if (!claudeMdContent.trim()) return claims;

  const fencedBlocks = extractFencedBlocks(claudeMdContent);
  const installOrTreeBlocks = fencedBlocks.filter((b) => b.isInstall || b.isTreeListing);

  // Helper to add a claim if not already seen
  function addClaim(claim: ClaudeMdClaim): void {
    const key = `${claim.type}:${claim.claimed.toLowerCase()}`;
    if (!seenClaims.has(key)) {
      seenClaims.add(key);
      claims.push(claim);
    }
  }

  // 1. Tech stack claims — scan for KNOWN_FRAMEWORKS names in prose
  for (const [frameworkName] of KNOWN_FRAMEWORKS) {
    const escapedName = frameworkName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`\\b${escapedName}\\b`, "gi");
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(claudeMdContent)) !== null) {
      // Skip if inside install or tree listing code block
      if (isInsideFencedBlock(match.index, installOrTreeBlocks)) continue;
      // Skip if in negation/comparison context
      if (isNegationContext(claudeMdContent, match.index, match[0].length)) continue;

      addClaim({
        type: "tech_stack",
        claimed: frameworkName,
        evidence: "", // filled by verifyClaudeMdClaims
        verified: false,
      });
      break; // Only need one mention per framework
    }
  }

  // 2. File path claims — look for paths in prose (not in tree listings)
  const pathPattern = /(?:^|\s|`)((?:src|lib|test|tests|app|pages|components|utils|hooks|api|server|public|config)\/[\w./-]+)/gm;
  let pathMatch: RegExpExecArray | null;

  while ((pathMatch = pathPattern.exec(claudeMdContent)) !== null) {
    // Strip trailing punctuation (periods, commas, colons, semicolons)
    const claimedPath = pathMatch[1].replace(/[.,;:]+$/, "");
    // Skip if inside tree listing block
    if (isInsideFencedBlock(pathMatch.index, installOrTreeBlocks)) continue;

    addClaim({
      type: "file_path",
      claimed: claimedPath,
      evidence: "",
      verified: false,
    });
  }

  // 3. Extract file paths from tree listing blocks (sample first 5 leaf nodes)
  for (const block of fencedBlocks.filter((b) => b.isTreeListing)) {
    const lines = block.content.split("\n").filter((l) => l.trim().length > 0);
    // Extract leaf-node paths: lines that look like they end with a file extension
    const leafPaths: string[] = [];
    for (const line of lines) {
      // Remove tree drawing chars and extract the filename
      const cleaned = line.replace(/[├└│─┬┼╠╚║╟╞\s]/g, "").trim();
      if (cleaned.includes(".") && !cleaned.startsWith(".")) {
        leafPaths.push(cleaned);
      }
      if (leafPaths.length >= 5) break;
    }

    if (leafPaths.length > 0) {
      addClaim({
        type: "file_path",
        claimed: `tree:[${leafPaths.join(",")}]`,
        evidence: "",
        verified: false,
      });
    }
  }

  // 4. Test framework claims
  for (const [runner] of TEST_RUNNERS) {
    const escapedRunner = runner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`\\b${escapedRunner}\\b`, "gi");
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(claudeMdContent)) !== null) {
      if (isInsideFencedBlock(match.index, installOrTreeBlocks)) continue;
      if (isNegationContext(claudeMdContent, match.index, match[0].length)) continue;

      addClaim({
        type: "test_framework",
        claimed: runner,
        evidence: "",
        verified: false,
      });
      break;
    }
  }

  // 5. Entry point claims — look for "entry point", "main file", "starts at" near file paths
  const entryPointPattern = /(?:entry\s*point|main\s*file|starts?\s*at|runs?\s*from)\s*(?:is\s*|:?\s*)?[`"]?([^\s`"]+\.\w+)[`"]?/gi;
  let epMatch: RegExpExecArray | null;

  while ((epMatch = entryPointPattern.exec(claudeMdContent)) !== null) {
    if (isInsideFencedBlock(epMatch.index, fencedBlocks.filter((b) => b.isInstall))) continue;

    addClaim({
      type: "entry_point",
      claimed: epMatch[1],
      evidence: "",
      verified: false,
    });
  }

  // 6. Command claims
  const commandClaims = extractCommandClaims(claudeMdContent);
  for (const claim of commandClaims) addClaim(claim);

  // 7. Test directory claims
  const testDirClaims = extractTestDirectoryClaims(claudeMdContent);
  for (const claim of testDirClaims) addClaim(claim);

  return claims;
}

// ── Command claim extraction ─────────────────────────────────────

/**
 * Extract verifiable command claims from fenced code blocks in CLAUDE.md.
 *
 * Extracts:
 * - `npm run <script>` / `yarn <script>` / `pnpm <script>` / `bun run <script>` → npm-script:<script>
 * - `npm test` / `npm start` → npm-script:test / npm-script:start
 * - `npx tsx <path>` / `npx ts-node <path>` / `node <path>` → file-command:<path>
 *
 * Skips: npm install, git, cd, mkdir, echo, comments, variable assignments, npx <package>.
 */
export function extractCommandClaims(claudeMdContent: string): ClaudeMdClaim[] {
  const claims: ClaudeMdClaim[] = [];
  const seen = new Set<string>();

  if (!claudeMdContent.trim()) return claims;

  // Match fenced code blocks (```bash, ```sh, ``` with no language, ```zsh)
  const fenceRegex = /^(`{3,}|~{3,})(bash|sh|zsh|shell|)?\s*\n([\s\S]*?)^\1/gm;
  let blockMatch: RegExpExecArray | null;

  while ((blockMatch = fenceRegex.exec(claudeMdContent)) !== null) {
    const blockContent = blockMatch[3] ?? "";
    const lines = blockContent.split("\n");

    for (const rawLine of lines) {
      // Strip leading whitespace, $, >, continuation chars
      const line = rawLine.replace(/^\s*[$>]\s*/, "").trim();
      if (!line) continue;

      // Skip comments, variable assignments, non-command lines
      if (line.startsWith("#")) continue;
      if (/^\w+=/.test(line)) continue;
      if (/^(cd|mkdir|echo|git|export|source|cat|cp|mv|rm|chmod|curl|wget)\b/.test(line)) continue;

      // npm/yarn/pnpm/bun run <script>
      const runMatch = line.match(/^(?:npm|yarn|pnpm|bun)\s+run\s+(\S+)/);
      if (runMatch) {
        const key = `npm-script:${runMatch[1]}`;
        if (!seen.has(key)) {
          seen.add(key);
          claims.push({ type: "command", claimed: key, evidence: "", verified: false });
        }
        continue;
      }

      // npm test / npm start (shorthand for npm run test / npm run start)
      const shorthandMatch = line.match(/^npm\s+(test|start)\b/);
      if (shorthandMatch) {
        const key = `npm-script:${shorthandMatch[1]}`;
        if (!seen.has(key)) {
          seen.add(key);
          claims.push({ type: "command", claimed: key, evidence: "", verified: false });
        }
        continue;
      }

      // bun test (shorthand)
      if (/^bun\s+test\b/.test(line)) {
        const key = "npm-script:test";
        if (!seen.has(key)) {
          seen.add(key);
          claims.push({ type: "command", claimed: key, evidence: "", verified: false });
        }
        continue;
      }

      // npx tsx <path> / npx ts-node <path> / node <path>
      const fileCommandMatch = line.match(/^(?:npx\s+(?:tsx|ts-node)|node)\s+(\S+)/);
      if (fileCommandMatch) {
        const filePath = fileCommandMatch[1].replace(/[.,;:]+$/, "");
        // Skip if it doesn't look like a file path (no / or no extension)
        if (filePath.includes("/") || filePath.includes(".")) {
          const key = `file-command:${filePath}`;
          if (!seen.has(key)) {
            seen.add(key);
            claims.push({ type: "command", claimed: key, evidence: "", verified: false });
          }
        }
        continue;
      }

      // Skip npx <package> (e.g., npx vitest) — not verifiable as file reference
      // Skip npm install, npm ci, etc.
    }
  }

  return claims;
}

// ── Test directory claim extraction ──────────────────────────────

/**
 * Extract test directory and test count claims from CLAUDE.md prose.
 *
 * Extracts:
 * - Test directory mentions: `test/`, `tests/`, `__tests__/`, `spec/` in prose
 * - Test file count claims: "N test files", "N tests" where N is a number
 *
 * Skips directories mentioned inside tree listing code blocks.
 */
export function extractTestDirectoryClaims(claudeMdContent: string): ClaudeMdClaim[] {
  const claims: ClaudeMdClaim[] = [];
  const seen = new Set<string>();

  if (!claudeMdContent.trim()) return claims;

  const fencedBlocks = extractFencedBlocks(claudeMdContent);
  const treeBlocks = fencedBlocks.filter((b) => b.isTreeListing);

  // 1. Test directory mentions in prose: `test/`, `tests/`, `__tests__/`, `spec/`, `specs/`
  const dirPattern = /`((?:test|tests|__tests__|spec|specs))\/?`/g;
  let dirMatch: RegExpExecArray | null;

  while ((dirMatch = dirPattern.exec(claudeMdContent)) !== null) {
    // Skip if inside tree listing
    if (isInsideFencedBlock(dirMatch.index, treeBlocks)) continue;

    const dirName = dirMatch[1];
    const key = `test-dir:${dirName}`;
    if (!seen.has(key)) {
      seen.add(key);
      claims.push({ type: "test_directory", claimed: key, evidence: "", verified: false });
    }
  }

  // 2. Test file count claims: "N test files", "N tests", "N test files"
  const countPattern = /(\d+)\s+test(?:\s+files?|s\b)/gi;
  let countMatch: RegExpExecArray | null;

  while ((countMatch = countPattern.exec(claudeMdContent)) !== null) {
    // Skip if inside a code block
    if (isInsideFencedBlock(countMatch.index, fencedBlocks)) continue;

    const count = parseInt(countMatch[1], 10);
    // Skip very small numbers that are probably not file counts (e.g., "2 test cases")
    if (count < 5) continue;

    const key = `test-count:${count}`;
    if (!seen.has(key)) {
      seen.add(key);
      claims.push({ type: "test_directory", claimed: key, evidence: "", verified: false });
    }
  }

  return claims;
}

// ── Test file counter (avoids circular import with bootstrap.ts) ─

const SKIP_DIRS = new Set(["node_modules", ".git", ".garyclaw", "dist", "build", ".next", "coverage"]);

/**
 * Recursively count files matching a pattern. Lightweight alternative to
 * walkFileTree that avoids the evaluate.ts ↔ bootstrap.ts circular import.
 */
function countTestFiles(dir: string, pattern: RegExp, cap = 5000): number {
  let count = 0;
  function walk(d: string): void {
    if (count >= cap) return;
    let entries: string[];
    try { entries = readdirSync(d); } catch { return; }
    for (const e of entries) {
      if (count >= cap) return;
      const full = join(d, e);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) {
          if (!SKIP_DIRS.has(e)) walk(full);
        } else if (pattern.test(e)) {
          count++;
        }
      } catch { /* permission error */ }
    }
  }
  walk(dir);
  return count;
}

// ── Claim verification ───────────────────────────────────────────

/**
 * Verify extracted claims against the filesystem and package.json.
 *
 * For tech_stack claims: checks if the framework's packages exist in deps.
 * For file_path claims: checks existsSync relative to projectDir.
 * For test_framework claims: checks devDeps or config file presence.
 * For entry_point claims: checks existsSync relative to projectDir.
 *
 * V1 scope: tech stack verification is Node-only (package.json).
 * Non-Node repos get claims marked verified with deferred evidence.
 */
export function verifyClaudeMdClaims(
  claims: ClaudeMdClaim[],
  projectDir: string,
  deps: string[],
): ClaudeMdClaim[] {
  const depSet = new Set(deps.map((d) => d.toLowerCase()));
  const hasPackageJson = existsSync(join(projectDir, "package.json"));

  // Pre-pass: count test-count claims to detect per-feature vs aggregate patterns
  const testCountClaimCount = claims.filter(
    (c) => c.type === "test_directory" && c.claimed.startsWith("test-count:"),
  ).length;

  return claims.map((claim) => {
    const verified = { ...claim };

    switch (claim.type) {
      case "tech_stack": {
        if (!hasPackageJson) {
          // Non-Node repo — defer verification
          verified.verified = true;
          verified.evidence = "non-Node repo, verification deferred";
          break;
        }

        const frameworkPackages = KNOWN_FRAMEWORKS.get(claim.claimed);
        if (!frameworkPackages) {
          verified.evidence = `unknown framework "${claim.claimed}"`;
          verified.verified = false;
          break;
        }

        const found = frameworkPackages.filter((pkg) => depSet.has(pkg.toLowerCase()));
        if (found.length > 0) {
          verified.verified = true;
          verified.evidence = `found in deps: ${found.join(", ")}`;
        } else {
          verified.verified = false;
          verified.evidence = `not found in any dependency field (checked: ${frameworkPackages.join(", ")})`;
        }
        break;
      }

      case "file_path": {
        // Handle tree listing claims: "tree:[path1,path2,...]"
        if (claim.claimed.startsWith("tree:[")) {
          const inner = claim.claimed.slice(6, -1); // strip "tree:[" and "]"
          const paths = inner.split(",").map((p) => p.trim()).filter(Boolean);
          const existing = paths.filter((p) => existsSync(join(projectDir, p)));

          // 80% threshold: pass if >= 4/5 sampled paths exist
          const threshold = Math.ceil(paths.length * 0.8);
          verified.verified = existing.length >= threshold;
          verified.evidence = `${existing.length}/${paths.length} tree paths exist (threshold: ${threshold})`;
          break;
        }

        // Regular file path
        if (existsSync(join(projectDir, claim.claimed))) {
          verified.verified = true;
          verified.evidence = "file exists";
        } else {
          verified.verified = false;
          verified.evidence = "file does not exist";
        }
        break;
      }

      case "test_framework": {
        const runner = TEST_RUNNERS.get(claim.claimed.toLowerCase());
        if (!runner) {
          verified.verified = false;
          verified.evidence = `unknown test runner "${claim.claimed}"`;
          break;
        }

        // Check packages in deps
        const foundPkg = runner.packages.filter((pkg) => depSet.has(pkg.toLowerCase()));
        if (foundPkg.length > 0) {
          verified.verified = true;
          verified.evidence = `found in deps: ${foundPkg.join(", ")}`;
          break;
        }

        // Check config file presence
        const foundConfig = runner.configFiles.filter((cf) => existsSync(join(projectDir, cf)));
        if (foundConfig.length > 0) {
          verified.verified = true;
          verified.evidence = `config file found: ${foundConfig.join(", ")}`;
          break;
        }

        verified.verified = false;
        verified.evidence = `no packages (${runner.packages.join(", ")}) or config files (${runner.configFiles.join(", ")}) found`;
        break;
      }

      case "entry_point": {
        if (existsSync(join(projectDir, claim.claimed))) {
          verified.verified = true;
          verified.evidence = "file exists";
        } else {
          verified.verified = false;
          verified.evidence = "file does not exist";
        }
        break;
      }

      case "command": {
        if (claim.claimed.startsWith("npm-script:")) {
          const scriptName = claim.claimed.slice("npm-script:".length);
          const pkgPath = join(projectDir, "package.json");
          if (!existsSync(pkgPath)) {
            verified.verified = true;
            verified.evidence = "no package.json, verification deferred";
            break;
          }
          try {
            const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
            const scripts = pkg.scripts ?? {};
            if (scriptName in scripts) {
              verified.verified = true;
              verified.evidence = `script exists: "${scripts[scriptName]}"`;
            } else {
              verified.verified = false;
              const available = Object.keys(scripts);
              verified.evidence = `no "${scriptName}" script in package.json${available.length > 0 ? ` (available: ${available.join(", ")})` : ""}`;
            }
          } catch {
            verified.verified = true;
            verified.evidence = "package.json parse error, verification deferred";
          }
        } else if (claim.claimed.startsWith("file-command:")) {
          const filePath = claim.claimed.slice("file-command:".length);
          if (existsSync(join(projectDir, filePath))) {
            verified.verified = true;
            verified.evidence = "file exists";
          } else {
            verified.verified = false;
            verified.evidence = "file does not exist";
          }
        }
        break;
      }

      case "test_directory": {
        if (claim.claimed.startsWith("test-dir:")) {
          const dirName = claim.claimed.slice("test-dir:".length);
          const dirPath = join(projectDir, dirName);
          if (existsSync(dirPath)) {
            verified.verified = true;
            verified.evidence = "directory exists";
          } else {
            const alternatives = ["test", "tests", "__tests__", "spec", "specs"];
            const found = alternatives.filter((d) => existsSync(join(projectDir, d)));
            verified.verified = false;
            verified.evidence = found.length > 0
              ? `directory does not exist (found instead: ${found.join(", ")})`
              : "directory does not exist (no test directory found)";
          }
        } else if (claim.claimed.startsWith("test-count:")) {
          const claimedCount = parseInt(claim.claimed.slice("test-count:".length), 10);
          const testPattern = /\.(test|spec)\.(ts|tsx|js|jsx|mjs)$/;

          if (testCountClaimCount > 1) {
            // Multiple per-feature counts: skip individual verification.
            // These are per-feature breakdowns, not repo-wide totals.
            let actualTotal: number;
            try {
              actualTotal = countTestFiles(projectDir, testPattern);
            } catch {
              actualTotal = 0;
            }
            verified.verified = true;
            verified.evidence = `per-feature count (${actualTotal} total test files in repo)`;
            break;
          }

          // Single aggregate count: verify against actual total with 20% tolerance
          let actualCount = 0;
          try {
            actualCount = countTestFiles(projectDir, testPattern);
          } catch {
            verified.verified = true;
            verified.evidence = "could not count test files, verification deferred";
            break;
          }
          // Allow 20% tolerance or 3 files, whichever is larger
          const tolerance = Math.max(3, Math.ceil(claimedCount * 0.2));
          if (Math.abs(actualCount - claimedCount) <= tolerance) {
            verified.verified = true;
            verified.evidence = `actual count: ${actualCount} (within tolerance of claimed ${claimedCount})`;
          } else {
            verified.verified = false;
            verified.evidence = `claimed ${claimedCount}, found ${actualCount} (±20% tolerance failed)`;
          }
        }
        break;
      }
    }

    return verified;
  });
}

/**
 * Generate reverse coverage claims: major frameworks in deps that CLAUDE.md never mentions.
 * These feed into the claim verification sub-score, not the framework coverage sub-score.
 */
export function generateReverseCoverageClaims(
  deps: string[],
  claudeMdContent: string,
): ClaudeMdClaim[] {
  const lowerContent = claudeMdContent.toLowerCase();
  const depSet = new Set(deps.map((d) => d.toLowerCase()));
  const claims: ClaudeMdClaim[] = [];

  for (const [frameworkName, packageNames] of KNOWN_FRAMEWORKS) {
    // Check if any of the framework's packages are in deps
    const inDeps = packageNames.some((pkg) => depSet.has(pkg.toLowerCase()));
    if (!inDeps) continue;

    // Check if the framework name is mentioned in CLAUDE.md (case-insensitive)
    if (!lowerContent.includes(frameworkName.toLowerCase())) {
      claims.push({
        type: "tech_stack",
        claimed: frameworkName,
        evidence: `present in deps but not mentioned in CLAUDE.md`,
        verified: false,
      });
    }
  }

  return claims;
}

// ── Bootstrap evaluation ─────────────────────────────────────────

/**
 * Analyze the quality of generated CLAUDE.md and TODOS.md.
 * Pure TypeScript — no Claude calls needed.
 */
export function analyzeBootstrapQuality(projectDir: string): BootstrapEvaluation {
  const claudeMdPath = join(projectDir, "CLAUDE.md");
  const todosMdPath = join(projectDir, "TODOS.md");
  const packageJsonPath = join(projectDir, "package.json");

  const result: BootstrapEvaluation = {
    claudeMdExists: false,
    claudeMdSizeTokens: 0,
    claudeMdHasSections: [],
    claudeMdMissingSections: [...EXPECTED_SECTIONS],
    todosMdExists: false,
    todosMdItemCount: 0,
    todosMdItemsAboveThreshold: 0,
    qualityScore: 0,
    qualityNotes: [],
  };

  // Check CLAUDE.md
  if (!existsSync(claudeMdPath)) {
    result.qualityNotes.push("No artifacts found — CLAUDE.md missing");
    result.qualityScore = 0;
    return result;
  }

  const claudeMdContent = safeReadText(claudeMdPath) ?? "";
  result.claudeMdExists = true;
  result.claudeMdSizeTokens = estimateTokens(claudeMdContent);

  // Detect sections
  const { found, missing } = detectSections(claudeMdContent);
  result.claudeMdHasSections = found;
  result.claudeMdMissingSections = missing;

  if (missing.length > 0) {
    result.qualityNotes.push(`Missing sections: ${missing.join(", ")}`);
  }

  // Extract and verify claims
  let deps: string[] = [];
  let coverageRatio = 1;

  if (existsSync(packageJsonPath)) {
    const pkgContent = safeReadText(packageJsonPath) ?? "";
    deps = extractDependencies(pkgContent);

    // Framework coverage (forward-direction only, for coverage sub-score)
    const coverage = computeFrameworkCoverage(deps, claudeMdContent);
    coverageRatio = coverage.coverage;
    if (coverage.total > 0 && coverage.mentioned < coverage.total) {
      result.qualityNotes.push(
        `Tech stack coverage: ${coverage.mentioned}/${coverage.total} known frameworks mentioned`,
      );
    }
  }

  // Extract forward claims from CLAUDE.md content
  const forwardClaims = extractClaudeMdClaims(claudeMdContent);
  // Verify forward claims against filesystem
  const verifiedForward = verifyClaudeMdClaims(forwardClaims, projectDir, deps);
  // Generate reverse coverage claims (deps in repo but not in doc)
  const reverseClaims = existsSync(packageJsonPath)
    ? generateReverseCoverageClaims(deps, claudeMdContent)
    : [];

  // Store all claims for reporting, but only score forward claims.
  // Reverse claims (deps in repo but not in doc) are already penalized
  // by the framework coverage sub-score — including them here would
  // double-count the same omission.
  const allClaims = [...verifiedForward, ...reverseClaims];
  result.claims = allClaims;
  result.claimsTotal = verifiedForward.length;
  result.claimsVerified = verifiedForward.filter((c) => c.verified).length;

  if (verifiedForward.length > 0) {
    const failedClaims = verifiedForward.filter((c) => !c.verified);
    if (failedClaims.length > 0) {
      result.qualityNotes.push(
        `Claim verification: ${result.claimsVerified}/${result.claimsTotal} claims verified (${failedClaims.length} failed)`,
      );
    }
  }

  // Check TODOS.md
  if (existsSync(todosMdPath)) {
    result.todosMdExists = true;
    const todosContent = safeReadText(todosMdPath) ?? "";
    // Count items (## P{N}: headings)
    const items = todosContent.match(/^## P\d:/gm) ?? [];
    result.todosMdItemCount = items.length;
    // We can't know which scored >5.0 without priority.md, so check if it exists
    const priorityPath = join(projectDir, ".garyclaw", "priority.md");
    if (existsSync(priorityPath)) {
      const priorityContent = safeReadText(priorityPath) ?? "";
      // Count items with score >5.0 from priority output
      const scoreMatches = priorityContent.match(/Score:\s*(\d+(?:\.\d+)?)/g) ?? [];
      result.todosMdItemsAboveThreshold = scoreMatches.filter((m) => {
        const score = parseFloat(m.replace("Score:", "").trim());
        return score > 5.0;
      }).length;
    }
  } else {
    result.qualityNotes.push("No artifacts found — TODOS.md missing");
  }

  // Compute quality score (0-100) — rebalanced weights
  // Structural completeness: 30 pts (reduced from 40)
  const structuralScore = (found.length / EXPECTED_SECTIONS.length) * 30;

  // Claim verification: 20 pts (forward claims only — reverse claims are
  // already penalized by framework coverage, so we exclude them to avoid
  // double-counting the same omission)
  let claimScore = 0;
  if (verifiedForward.length > 0) {
    claimScore = (result.claimsVerified / result.claimsTotal) * 20;
  } else {
    // No claims extracted — neutral score (vagueness is not rewarded)
    claimScore = 10;
  }
  result.claimVerificationScore = Math.round(claimScore * 100) / 100;

  // Framework coverage: 20 pts (reduced from 30, forward-direction only)
  const accuracyScore = coverageRatio * 20;

  // TODOS.md viability: 20 pts (unchanged)
  let viabilityScore = 0;
  if (result.todosMdExists && result.todosMdItemCount > 0) {
    viabilityScore = (result.todosMdItemsAboveThreshold / result.todosMdItemCount) * 20;
  }

  // Token efficiency: 10 pts (unchanged)
  const efficiencyScore = scoreTokenEfficiency(result.claudeMdSizeTokens);

  result.qualityScore = Math.round(structuralScore + claimScore + accuracyScore + viabilityScore + efficiencyScore);

  return result;
}

// ── Oracle evaluation ────────────────────────────────────────────

/**
 * Analyze Oracle decision performance from decisions.jsonl.
 */
export function analyzeOraclePerformance(projectDir: string): OracleEvaluation {
  const result: OracleEvaluation = {
    totalDecisions: 0,
    lowConfidenceCount: 0,
    escalatedCount: 0,
    averageConfidence: 0,
    topicClusters: [],
    researchTriggered: false,
  };

  // Read decisions from .garyclaw/decisions.jsonl
  const decisionsPath = join(projectDir, ".garyclaw", "decisions.jsonl");
  if (!existsSync(decisionsPath)) return result;

  const content = safeReadText(decisionsPath) ?? "";
  const lines = content.trim().split("\n").filter(Boolean);
  const decisions: Decision[] = [];

  for (const line of lines) {
    try {
      const d = JSON.parse(line) as Decision;
      if (d.question && typeof d.confidence === "number") {
        decisions.push(d);
      }
    } catch {
      // skip corrupt lines
    }
  }

  if (decisions.length === 0) return result;

  result.totalDecisions = decisions.length;
  result.lowConfidenceCount = decisions.filter((d) => d.confidence < 6).length;
  result.averageConfidence = decisions.reduce((sum, d) => sum + d.confidence, 0) / decisions.length;

  // Check for escalated decisions
  const escalatedPath = join(projectDir, ".garyclaw", "escalated.jsonl");
  if (existsSync(escalatedPath)) {
    const escContent = safeReadText(escalatedPath) ?? "";
    const escLines = escContent.trim().split("\n").filter(Boolean);
    result.escalatedCount = escLines.length;
  }

  // Topic clustering using auto-research's groupDecisionsByTopic
  const groups = groupDecisionsByTopic(decisions, {
    ...DEFAULT_AUTO_RESEARCH_CONFIG,
    lowConfidenceThreshold: 6,
  });
  result.topicClusters = groups.map((g) => ({
    topic: g.topic,
    count: g.decisions.length,
    avgConfidence: g.avgConfidence,
  }));

  // Check if auto-research was triggered
  const daemonStatePath = join(projectDir, ".garyclaw", "daemon-state.json");
  if (existsSync(daemonStatePath)) {
    const state = safeReadJSON<{ jobs?: { triggeredBy?: string }[] }>(daemonStatePath);
    if (state?.jobs) {
      result.researchTriggered = state.jobs.some((j) => j.triggeredBy === "auto_research");
    }
  }

  return result;
}

// ── Pipeline evaluation ──────────────────────────────────────────

/**
 * Analyze pipeline health from pipeline.json and checkpoint files.
 */
export function analyzePipelineHealth(projectDir: string): PipelineEvaluation {
  const result: PipelineEvaluation = {
    skillsRun: [],
    skillsCompleted: [],
    skillsFailed: [],
    totalRelays: 0,
    totalCostUsd: 0,
    totalDurationSec: 0,
    contextGrowthRate: 0,
    adaptiveTurnsUsed: false,
  };

  // Read pipeline state
  const pipelinePath = join(projectDir, ".garyclaw", "pipeline.json");
  if (!existsSync(pipelinePath)) return result;

  const state = safeReadJSON<PipelineState>(pipelinePath);
  if (!state?.skills) return result;

  result.skillsRun = state.skills.map((s) => s.skillName);
  result.skillsCompleted = state.skills.filter((s) => s.status === "complete").map((s) => s.skillName);
  result.skillsFailed = state.skills.filter((s) => s.status === "failed").map((s) => s.skillName);
  result.totalCostUsd = state.totalCostUsd ?? 0;

  // Compute duration from timestamps
  if (state.startTime) {
    const start = new Date(state.startTime).getTime();
    const lastSkill = state.skills.filter((s) => s.endTime).pop();
    // Use last skill's endTime if available, otherwise fall back to now
    // (pipeline may still be running or skills crashed without recording end)
    const end = lastSkill?.endTime
      ? new Date(lastSkill.endTime).getTime()
      : Date.now();
    result.totalDurationSec = Math.max(0, (end - start) / 1000);
  }

  // Count relays from checkpoint files and compute growth rates
  const growthRates: number[] = [];
  const checkpointDir = join(projectDir, ".garyclaw");

  for (let i = 0; i < state.skills.length; i++) {
    const skillDir = join(checkpointDir, `skill-${i}-${state.skills[i].skillName}`);
    if (!existsSync(skillDir)) continue;

    // Read checkpoint for relay and growth data
    const cpPath = join(skillDir, "checkpoint.json");
    if (!existsSync(cpPath)) continue;

    const cp = safeReadJSON<{ tokenUsage?: { turnHistory?: { computedContextSize: number; turn: number }[]; sessionCount?: number } }>(cpPath);
    if (!cp?.tokenUsage) continue;

    // Count relays (sessionCount > 1 means relays happened)
    const sessions = cp.tokenUsage.sessionCount ?? 1;
    if (sessions > 1) {
      result.totalRelays += sessions - 1;
    }

    // Compute growth rate from turn history
    if (cp.tokenUsage.turnHistory && cp.tokenUsage.turnHistory.length >= 2) {
      const monitorState: TokenMonitorState = {
        contextWindow: 1_000_000,
        totalOutputTokens: 0,
        estimatedCostUsd: 0,
        turnHistory: cp.tokenUsage.turnHistory.map((t, idx) => ({
          turn: t.turn ?? idx + 1,
          inputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          computedContextSize: t.computedContextSize,
        })),
        turnCounter: cp.tokenUsage.turnHistory.length,
      };
      const rate = computeGrowthRate(monitorState);
      if (rate !== null) {
        growthRates.push(rate);
      }
    }
  }

  // Average growth rate across all segments
  if (growthRates.length > 0) {
    result.contextGrowthRate = growthRates.reduce((sum, r) => sum + r, 0) / growthRates.length;
  }

  // Check for adaptive turns events in daemon state
  const daemonStatePath = join(projectDir, ".garyclaw", "daemon-state.json");
  if (existsSync(daemonStatePath)) {
    const dState = safeReadJSON<{ jobs?: { adaptiveTurnsStats?: { adaptiveCount?: number } }[] }>(daemonStatePath);
    if (dState?.jobs) {
      result.adaptiveTurnsUsed = dState.jobs.some(
        (j) => j.adaptiveTurnsStats && (j.adaptiveTurnsStats.adaptiveCount ?? 0) > 0,
      );
    }
  }

  return result;
}

// ── Obvious improvements extraction ──────────────────────────────

/**
 * Extract deterministic improvement candidates from metrics thresholds.
 * Pure function — no Claude calls needed.
 */
export function extractObviousImprovements(report: EvaluationReport): ImprovementCandidate[] {
  const candidates: ImprovementCandidate[] = [];

  // Bootstrap missing sections → P2
  if (report.bootstrap.claudeMdExists && report.bootstrap.claudeMdMissingSections.length > 0) {
    candidates.push({
      title: `Bootstrap missing ${report.bootstrap.claudeMdMissingSections.join(", ")} detection`,
      priority: "P2",
      effort: "XS",
      category: "bootstrap",
      description: `Bootstrap's analyzeCodebase() doesn't generate ${report.bootstrap.claudeMdMissingSections.join(", ")} section(s). These expected sections were absent from the generated CLAUDE.md.`,
      evidence: `Target repo CLAUDE.md missing sections: ${report.bootstrap.claudeMdMissingSections.join(", ")}`,
    });
  }

  // Low-confidence Oracle clusters (3+ decisions, avg confidence < 6) → P3
  for (const cluster of report.oracle.topicClusters) {
    if (cluster.count >= 3 && cluster.avgConfidence < 6) {
      candidates.push({
        title: `Oracle domain gap — ${cluster.topic}`,
        priority: "P3",
        effort: "XS",
        category: "oracle",
        description: `Oracle made ${cluster.count} low-confidence decisions about "${cluster.topic}". Domain expertise research should be auto-triggered for this topic.`,
        evidence: `${cluster.count} decisions, avg confidence ${cluster.avgConfidence.toFixed(1)}/10`,
      });
    }
  }

  // High relay count for single skills → P3
  if (report.pipeline.totalRelays > 3) {
    candidates.push({
      title: "Excessive relays in dogfood pipeline",
      priority: "P3",
      effort: "S",
      category: "relay",
      description: `Pipeline triggered ${report.pipeline.totalRelays} relays total. Consider optimizing context usage or increasing relay threshold for dogfood runs.`,
      evidence: `${report.pipeline.totalRelays} relays across ${report.pipeline.skillsRun.length} skills`,
    });
  }

  // Failed skills → P2
  if (report.pipeline.skillsFailed.length > 0) {
    candidates.push({
      title: `Pipeline skill failures: ${report.pipeline.skillsFailed.join(", ")}`,
      priority: "P2",
      effort: "S",
      category: "pipeline",
      description: `${report.pipeline.skillsFailed.length} skill(s) failed during the dogfood pipeline. Investigate root cause and add resilience.`,
      evidence: `Failed: ${report.pipeline.skillsFailed.join(", ")}. Completed: ${report.pipeline.skillsCompleted.join(", ")}`,
    });
  }

  // Low bootstrap quality → P2
  if (report.bootstrap.claudeMdExists && report.bootstrap.qualityScore < BOOTSTRAP_QUALITY_THRESHOLD) {
    candidates.push({
      title: "Bootstrap quality below threshold",
      priority: "P2",
      effort: "M",
      category: "bootstrap",
      description: `Bootstrap quality score is ${report.bootstrap.qualityScore}/100. The generated CLAUDE.md needs significant improvement in completeness and accuracy.`,
      evidence: `Quality score: ${report.bootstrap.qualityScore}/100. Notes: ${report.bootstrap.qualityNotes.join("; ")}`,
    });
  }

  return candidates;
}

// ── Claude improvements parsing ──────────────────────────────────

const VALID_PRIORITIES = new Set<ImprovementPriority>(["P2", "P3", "P4"]);
const VALID_EFFORTS = new Set<ImprovementEffort>(["XS", "S", "M"]);
const VALID_CATEGORIES = new Set<ImprovementCategory>(["bootstrap", "oracle", "pipeline", "skill", "relay"]);

/**
 * Parse improvement candidates from Claude's segment output.
 * Expects a JSON array within an <improvements> block.
 *
 * Uses a "last valid match" strategy: iterates all <improvements> blocks
 * from last to first, returning the first one that successfully parses.
 * This handles relay boundary splits where the first block may be
 * truncated mid-JSON.
 */
export function parseClaudeImprovements(output: string): ImprovementCandidate[] {
  // Extract all <improvements> blocks
  const blocks = [...output.matchAll(/<improvements>([\s\S]*?)<\/improvements>/g)];
  if (blocks.length === 0) return [];

  // Try each block from last to first, return first that parses
  for (let i = blocks.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(blocks[i][1].trim());
      if (!Array.isArray(parsed)) continue;

      const valid: ImprovementCandidate[] = [];
      for (const item of parsed) {
        if (
          typeof item.title === "string" &&
          typeof item.description === "string" &&
          typeof item.evidence === "string" &&
          VALID_PRIORITIES.has(item.priority) &&
          VALID_EFFORTS.has(item.effort) &&
          VALID_CATEGORIES.has(item.category)
        ) {
          valid.push({
            title: item.title,
            priority: item.priority,
            effort: item.effort,
            category: item.category,
            description: item.description,
            evidence: item.evidence,
          });
        }
      }
      // Only return if we found at least one qualifying item.
      // A block with valid JSON but zero qualifying items should
      // not short-circuit — try earlier blocks instead.
      if (valid.length > 0) return valid;
    } catch {
      continue;
    }
  }
  return [];
}

// ── Dedup improvements ───────────────────────────────────────────

/**
 * Merge obvious + Claude improvements, deduplicating by normalized Levenshtein
 * distance < 0.3 on titles. When duplicates exist, keep the version with
 * longer evidence (proxy for more specific).
 */
export function deduplicateImprovements(
  obvious: ImprovementCandidate[],
  claude: ImprovementCandidate[],
): ImprovementCandidate[] {
  const all = [...obvious, ...claude];
  const result: ImprovementCandidate[] = [];

  for (const candidate of all) {
    const duplicate = result.findIndex(
      (existing) => normalizedLevenshtein(existing.title, candidate.title) < 0.3,
    );

    if (duplicate === -1) {
      result.push(candidate);
    } else {
      // Keep the one with more specific evidence
      if (candidate.evidence.length > result[duplicate].evidence.length) {
        result[duplicate] = candidate;
      }
    }
  }

  return result;
}

// ── Report formatting ────────────────────────────────────────────

/**
 * Format the evaluation report as human-readable markdown.
 */
export function formatEvaluationReport(report: EvaluationReport): string {
  const lines: string[] = [];

  lines.push("# Dogfood Evaluation Report");
  lines.push("");
  lines.push(`**Target:** ${report.targetRepo}`);
  lines.push(`**Date:** ${report.timestamp}`);
  lines.push(`**Pipeline:** ${report.pipeline.skillsRun.join(" → ")}`);
  lines.push("");

  // Bootstrap Quality
  lines.push(`## Bootstrap Quality: ${report.bootstrap.qualityScore}/100`);
  lines.push("");
  lines.push("| Check | Result |");
  lines.push("|-------|--------|");
  lines.push(`| CLAUDE.md exists | ${report.bootstrap.claudeMdExists ? "YES" : "NO"} |`);
  lines.push(`| CLAUDE.md size | ${report.bootstrap.claudeMdSizeTokens.toLocaleString()} tokens |`);
  for (const section of EXPECTED_SECTIONS) {
    const has = report.bootstrap.claudeMdHasSections.includes(section);
    lines.push(`| ${section} section | ${has ? "YES" : "MISSING"} |`);
  }
  lines.push(`| TODOS.md exists | ${report.bootstrap.todosMdExists ? "YES" : "NO"} |`);
  lines.push(`| TODOS.md items | ${report.bootstrap.todosMdItemCount} |`);
  lines.push(`| Items above 5.0 threshold | ${report.bootstrap.todosMdItemsAboveThreshold} |`);
  lines.push("");

  if (report.bootstrap.qualityNotes.length > 0) {
    lines.push("**Notes:**");
    for (const note of report.bootstrap.qualityNotes) {
      lines.push(`- ${note}`);
    }
    lines.push("");
  }

  const failedClaims = (report.bootstrap.claims ?? []).filter((c) => !c.verified);
  if (failedClaims.length > 0) {
    lines.push("**Failed Claims:**");
    for (const claim of failedClaims) {
      lines.push(`- [${claim.type}] "${claim.claimed}" — ${claim.evidence}`);
    }
    lines.push("");
  }

  // Oracle Performance
  lines.push("## Oracle Performance");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  lines.push(`| Total decisions | ${report.oracle.totalDecisions} |`);
  lines.push(`| Low confidence (<6) | ${report.oracle.lowConfidenceCount} |`);
  lines.push(`| Escalated | ${report.oracle.escalatedCount} |`);
  lines.push(`| Avg confidence | ${report.oracle.averageConfidence.toFixed(1)} |`);
  lines.push(`| Auto-research triggered | ${report.oracle.researchTriggered ? "Yes" : "No"} |`);
  lines.push("");

  if (report.oracle.topicClusters.length > 0) {
    lines.push("**Low-confidence clusters:**");
    for (const cluster of report.oracle.topicClusters) {
      lines.push(`- "${cluster.topic}" (${cluster.count} decisions, avg confidence ${cluster.avgConfidence.toFixed(1)})`);
    }
    lines.push("");
  }

  // Pipeline Health
  lines.push("## Pipeline Health");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  lines.push(`| Skills run | ${report.pipeline.skillsCompleted.length}/${report.pipeline.skillsRun.length} |`);
  lines.push(`| Total relays | ${report.pipeline.totalRelays} |`);
  lines.push(`| Total cost | $${report.pipeline.totalCostUsd.toFixed(2)} |`);
  lines.push(`| Duration | ${formatDuration(report.pipeline.totalDurationSec)} |`);
  lines.push(`| Avg context growth | ${report.pipeline.contextGrowthRate.toFixed(2)}/turn |`);
  lines.push("");

  // Improvement Candidates
  if (report.improvements.length > 0) {
    lines.push("## GaryClaw Improvement Candidates");
    lines.push("");
    for (const imp of report.improvements) {
      lines.push(`### ${imp.priority}: ${imp.title}`);
      lines.push(imp.description);
      lines.push(`**Effort:** ${imp.effort} | **Category:** ${imp.category}`);
      lines.push(`**Evidence:** ${imp.evidence}`);
      lines.push("");
    }
  }

  lines.push("---");
  lines.push("*Generated by GaryClaw Evaluate Skill*");

  return lines.join("\n");
}

/** Format seconds into human-readable duration */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}

// ── TODOS.md formatting ──────────────────────────────────────────

/**
 * Format improvement candidates as TODOS.md entries matching parseTodoItems() contract.
 */
export function formatImprovementCandidates(
  candidates: ImprovementCandidate[],
  date: string = new Date().toISOString().split("T")[0],
): string {
  const blocks: string[] = [];

  for (const c of candidates) {
    blocks.push(`## ${c.priority}: ${c.title}

**What:** ${c.description}

**Why:** ${c.evidence}

**Effort:** ${c.effort} (human: ~${humanEffortEstimate(c.effort)} / CC: ~${ccEffortEstimate(c.effort)})
**Depends on:** Nothing
**Added by:** evaluate skill on ${date}`);
  }

  return blocks.join("\n\n");
}

function humanEffortEstimate(effort: ImprovementEffort): string {
  switch (effort) {
    case "XS": return "30min";
    case "S": return "2 days";
    case "M": return "1 week";
  }
}

function ccEffortEstimate(effort: ImprovementEffort): string {
  switch (effort) {
    case "XS": return "5min";
    case "S": return "20min";
    case "M": return "1h";
  }
}

// ── Default evaluation fallbacks ──────────────────────────────────

/** Default BootstrapEvaluation for error-boundary fallback. */
export function defaultBootstrapEvaluation(): BootstrapEvaluation {
  return {
    claudeMdExists: false,
    claudeMdSizeTokens: 0,
    claudeMdHasSections: [],
    claudeMdMissingSections: [...EXPECTED_SECTIONS],
    todosMdExists: false,
    todosMdItemCount: 0,
    todosMdItemsAboveThreshold: 0,
    qualityScore: 0,
    qualityNotes: [],
  };
}

/** Default OracleEvaluation for error-boundary fallback. */
export function defaultOracleEvaluation(): OracleEvaluation {
  return {
    totalDecisions: 0,
    lowConfidenceCount: 0,
    escalatedCount: 0,
    averageConfidence: 0,
    topicClusters: [],
    researchTriggered: false,
  };
}

/** Default PipelineEvaluation for error-boundary fallback. */
export function defaultPipelineEvaluation(): PipelineEvaluation {
  return {
    skillsRun: [],
    skillsCompleted: [],
    skillsFailed: [],
    totalRelays: 0,
    totalCostUsd: 0,
    totalDurationSec: 0,
    contextGrowthRate: 0,
    adaptiveTurnsUsed: false,
  };
}

/** Error-boundary helper: call fn, return fallback on throw. */
function safeAnalyze<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
}

// ── Post-evaluate deterministic analysis ─────────────────────────

/**
 * Post-evaluate deterministic analysis. Called by pipeline.ts after the
 * evaluate segment completes. Runs all TS analysis, parses Claude's
 * <improvements>, merges, deduplicates, and writes the final evaluation
 * report + improvement-candidates.md.
 *
 * Note on multi-relay text: if the evaluate skill relays, the accumulated
 * claudeOutput contains text from ALL segments. parseClaudeImprovements
 * uses a "last valid match" strategy: iterates all <improvements> blocks
 * from last to first, returning the first one that parses. This handles
 * relay boundary splits where an earlier block may be truncated mid-JSON.
 */
export function runPostEvaluateAnalysis(
  projectDir: string,
  claudeOutput: string,
): EvaluationReport {
  // 1. Run deterministic analysis (error notes for traceability, matching buildEvaluatePrompt)
  const bootstrap = safeAnalyze(() => analyzeBootstrapQuality(projectDir), {
    ...defaultBootstrapEvaluation(),
    qualityNotes: ["analyzeBootstrapQuality threw an error"],
  });
  const oracle = safeAnalyze(() => analyzeOraclePerformance(projectDir), defaultOracleEvaluation());
  const pipeline = safeAnalyze(() => analyzePipelineHealth(projectDir), defaultPipelineEvaluation());

  // 2. Extract obvious improvements from metrics
  const partialReport: EvaluationReport = {
    targetRepo: projectDir,
    timestamp: new Date().toISOString(),
    bootstrap,
    oracle,
    pipeline,
    improvements: [],
  };
  const obvious = safeAnalyze(() => extractObviousImprovements(partialReport), []);

  // 3. Parse Claude's <improvements> output
  const claudeImprovements = parseClaudeImprovements(claudeOutput);

  // 4. Merge + deduplicate
  const merged = deduplicateImprovements(obvious, claudeImprovements);

  // 5. Build final report and write to disk
  const report: EvaluationReport = { ...partialReport, improvements: merged };
  writeEvaluationReport(projectDir, report);

  return report;
}

// ── Report writing ───────────────────────────────────────────────

/**
 * Write evaluation report to .garyclaw/ directory as both JSON and markdown.
 */
export function writeEvaluationReport(projectDir: string, report: EvaluationReport): void {
  const dir = join(projectDir, ".garyclaw");
  mkdirSync(dir, { recursive: true });

  safeWriteJSON(join(dir, "evaluation-report.json"), report);
  safeWriteText(join(dir, "evaluation-report.md"), formatEvaluationReport(report));

  // Also write improvement candidates for standalone mode
  const candidatesPath = join(dir, "improvement-candidates.md");
  if (report.improvements.length > 0) {
    safeWriteText(
      candidatesPath,
      formatImprovementCandidates(report.improvements, report.timestamp.split("T")[0]),
    );
  } else {
    // Delete stale file from a previous run to prevent cli.ts hook from
    // re-appending the same improvements to TODOS.md on every subsequent run.
    try { unlinkSync(candidatesPath); } catch { /* file may not exist */ }
  }
}

// ── Prompt builder ───────────────────────────────────────────────

/**
 * Build the evaluation prompt for Claude. Assembles all analysis data
 * and asks Claude to synthesize additional improvement candidates.
 */
export function buildEvaluatePrompt(
  _config: GaryClawConfig,
  previousSkills: PipelineSkillEntry[],
  projectDir: string,
): string {
  // Run all analysis functions with error boundary — corrupt .garyclaw/ data
  // should degrade gracefully, not crash the entire evaluate skill.
  let bootstrap: ReturnType<typeof analyzeBootstrapQuality>;
  let oracle: ReturnType<typeof analyzeOraclePerformance>;
  let pipeline: ReturnType<typeof analyzePipelineHealth>;
  let obvious: ReturnType<typeof extractObviousImprovements>;

  bootstrap = safeAnalyze(() => analyzeBootstrapQuality(projectDir), {
    ...defaultBootstrapEvaluation(),
    qualityNotes: ["analyzeBootstrapQuality threw an error"],
  });

  oracle = safeAnalyze(() => analyzeOraclePerformance(projectDir), defaultOracleEvaluation());

  pipeline = safeAnalyze(() => analyzePipelineHealth(projectDir), defaultPipelineEvaluation());

  obvious = safeAnalyze(() => extractObviousImprovements({
    targetRepo: projectDir,
    timestamp: new Date().toISOString(),
    bootstrap,
    oracle,
    pipeline,
    improvements: [],
  }), []);

  const lines: string[] = [];

  lines.push("You are a GaryClaw self-improvement analyst. You just finished running the dogfood pipeline on an external repository. Your job is to analyze the results and identify improvement opportunities for GaryClaw itself.");
  lines.push("");

  // Section 1: Analysis data
  lines.push("## Evaluation Data");
  lines.push("");
  lines.push("### Bootstrap Quality");
  lines.push(`- CLAUDE.md exists: ${bootstrap.claudeMdExists}`);
  lines.push(`- CLAUDE.md size: ${bootstrap.claudeMdSizeTokens} tokens`);
  lines.push(`- Sections found: ${bootstrap.claudeMdHasSections.join(", ") || "none"}`);
  lines.push(`- Sections missing: ${bootstrap.claudeMdMissingSections.join(", ") || "none"}`);
  lines.push(`- Quality score: ${bootstrap.qualityScore}/100`);
  lines.push(`- Notes: ${bootstrap.qualityNotes.join("; ") || "none"}`);
  lines.push("");

  lines.push("### Oracle Performance");
  lines.push(`- Total decisions: ${oracle.totalDecisions}`);
  lines.push(`- Low confidence (<6): ${oracle.lowConfidenceCount}`);
  lines.push(`- Escalated: ${oracle.escalatedCount}`);
  lines.push(`- Average confidence: ${oracle.averageConfidence.toFixed(1)}`);
  if (oracle.topicClusters.length > 0) {
    lines.push("- Topic clusters:");
    for (const c of oracle.topicClusters) {
      lines.push(`  - "${c.topic}" (${c.count} decisions, avg ${c.avgConfidence.toFixed(1)})`);
    }
  }
  lines.push("");

  lines.push("### Pipeline Health");
  lines.push(`- Skills run: ${pipeline.skillsRun.join(", ") || "none"}`);
  lines.push(`- Completed: ${pipeline.skillsCompleted.join(", ") || "none"}`);
  lines.push(`- Failed: ${pipeline.skillsFailed.join(", ") || "none"}`);
  lines.push(`- Total relays: ${pipeline.totalRelays}`);
  lines.push(`- Total cost: $${pipeline.totalCostUsd.toFixed(2)}`);
  lines.push(`- Duration: ${formatDuration(pipeline.totalDurationSec)}`);
  lines.push(`- Context growth rate: ${pipeline.contextGrowthRate.toFixed(2)} tok/turn`);
  lines.push("");

  // Section 2: Already-identified improvements
  if (obvious.length > 0) {
    lines.push("### Already Identified Improvements");
    for (const imp of obvious) {
      lines.push(`- [${imp.priority}] ${imp.title}: ${imp.description}`);
    }
    lines.push("");
  }

  // Section 3: Previous skill context
  if (previousSkills.length > 0) {
    lines.push("### Previous Skills Context");
    for (const skill of previousSkills) {
      if (skill.report) {
        lines.push(`- /${skill.skillName}: ${skill.report.issues.length} issues, ${skill.report.findings.length} findings, $${skill.report.estimatedCostUsd.toFixed(3)}`);
      }
    }
    lines.push("");
  }

  // Project type awareness
  const ptSection = buildProjectTypeSection(projectDir);
  if (ptSection) lines.push(ptSection);

  // Section 4: Instructions
  lines.push("## Instructions");
  lines.push("");
  lines.push("1. Review the evaluation data above.");
  lines.push("2. Identify additional GaryClaw improvement opportunities that the automated analysis missed.");
  lines.push("3. Focus on improvements to GaryClaw itself (not the target repo).");
  lines.push("4. Prioritize improvements that would make the next dogfood run more effective.");
  lines.push("5. Output your improvement candidates as a JSON array in an <improvements> block.");
  lines.push("");
  lines.push("Output format:");
  lines.push("```");
  lines.push("<improvements>");
  lines.push('[');
  lines.push('  { "title": "...", "priority": "P3", "effort": "S", "category": "bootstrap", "description": "...", "evidence": "..." }');
  lines.push(']');
  lines.push("</improvements>");
  lines.push("```");
  lines.push("");
  lines.push("Valid priorities: P2, P3, P4 (P1 reserved for human-escalated)");
  lines.push("Valid efforts: XS, S, M");
  lines.push("Valid categories: bootstrap, oracle, pipeline, skill, relay");
  lines.push("");
  lines.push("Do NOT write any files. The pipeline handles report generation deterministically from your <improvements> output.");

  return lines.join("\n");
}
