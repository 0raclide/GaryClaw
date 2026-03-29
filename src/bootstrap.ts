/**
 * Bootstrap skill — generates CLAUDE.md and TODOS.md for cold-start repos.
 *
 * Analyzes a target codebase in TypeScript (not Claude tool calls), then
 * builds a prompt that instructs Claude to write project artifacts.
 * Idempotency: if CLAUDE.md or TODOS.md already exist, those write
 * instructions are omitted from the prompt.
 *
 * Follows the implement.ts/prioritize.ts pattern: pure functions that
 * build a prompt string, dispatched from pipeline.ts via runSkillWithPrompt().
 */

import { readdirSync, readFileSync, statSync, existsSync, realpathSync, openSync, readSync, closeSync } from "node:fs";
import { join, relative, extname, basename } from "node:path";

import { estimateTokens, readCheckpoint, generateRelayPrompt } from "./checkpoint.js";
import type { GaryClawConfig, PipelineSkillEntry } from "./types.js";

// ── Constants ────────────────────────────────────────────────────

/** Total token budget for gathered codebase content injected into the prompt. */
export const TOKEN_BUDGET = 50_000;

/** Max tokens for package.json + tsconfig.json + CI config + lock file metadata. */
const TIER1_BUDGET = 2_000;

/** Max tokens for README content. */
const README_BUDGET = 5_000;

/** Max tokens for file tree listing. */
const FILE_TREE_BUDGET = 5_000;

/** Source file extensions we recognize. */
const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift",
  ".c", ".cpp", ".h", ".hpp", ".cs", ".php",
  ".vue", ".svelte", ".astro",
  ".sh", ".bash", ".zsh",
  ".sql", ".graphql", ".gql",
  ".css", ".scss", ".less",
  ".html", ".htm",
  ".yaml", ".yml", ".toml", ".json",
]);

/** Binary/generated file extensions to skip. */
const SKIP_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp", ".avif",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".pdf", ".zip", ".tar", ".gz", ".bz2", ".7z",
  ".mp3", ".mp4", ".wav", ".avi", ".mov",
  ".exe", ".dll", ".so", ".dylib", ".o", ".a",
  ".wasm", ".map",
  ".lock",
]);

/** Directories to skip when walking the file tree. */
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".nuxt",
  "vendor", "venv", ".venv", "__pycache__", ".tox",
  "target", "out", "bin", "obj",
  ".garyclaw", ".gstack",
  "coverage", ".nyc_output",
]);

/** CI config file patterns. */
const CI_PATTERNS = [
  ".github/workflows",
  ".gitlab-ci.yml",
  ".circleci/config.yml",
  ".travis.yml",
  "Jenkinsfile",
  "bitbucket-pipelines.yml",
];

// ── CodebaseAnalysis interface ───────────────────────────────────

export interface CodebaseAnalysis {
  techStack: string[];
  packageJson: string | null;
  tsConfig: string | null;
  ciConfig: string | null;
  readme: string | null;
  fileTree: string;
  testDir: string | null;
  sourceFiles: Record<string, string>;
  existingClaudeMd: boolean;
  existingTodosMd: boolean;
  totalSourceFiles: number;
  totalTokensGathered: number;
  errors: string[];
}

// ── File tree walking ────────────────────────────────────────────

/**
 * Walk a directory tree, collecting file paths relative to root.
 * Handles symlink cycles via realpath tracking.
 * Caps at maxFiles to avoid runaway on huge repos.
 */
export function walkFileTree(
  rootDir: string,
  maxFiles: number = 5000,
): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  const visitedRealpaths = new Set<string>();
  let truncated = false;

  function walk(dir: string): void {
    if (files.length >= maxFiles) {
      truncated = true;
      return;
    }

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // permission error — skip silently
    }

    // Sort for deterministic output
    entries.sort();

    for (const entry of entries) {
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }

      const fullPath = join(dir, entry);

      // Skip known directories
      if (SKIP_DIRS.has(entry)) continue;

      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue; // permission error — skip
      }

      if (stat.isDirectory()) {
        // Detect symlink cycles
        try {
          const real = realpathSync(fullPath);
          if (visitedRealpaths.has(real)) continue;
          visitedRealpaths.add(real);
        } catch {
          continue; // broken symlink
        }
        walk(fullPath);
      } else if (stat.isFile()) {
        const relPath = relative(rootDir, fullPath);
        files.push(relPath);
      }
    }
  }

  // Track root itself to avoid cycles
  try {
    visitedRealpaths.add(realpathSync(rootDir));
  } catch {
    // If we can't resolve root, proceed anyway
  }

  walk(rootDir);
  return { files, truncated };
}

// ── Tech stack detection ─────────────────────────────────────────

/**
 * Detect technology stack from file presence and package.json contents.
 */
export function detectTechStack(
  projectDir: string,
  files: string[],
  packageJsonContent: string | null,
): string[] {
  const stack: string[] = [];

  // Language detection from file extensions
  const extCounts = new Map<string, number>();
  for (const f of files) {
    const ext = extname(f).toLowerCase();
    if (SOURCE_EXTENSIONS.has(ext)) {
      extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
    }
  }

  if ((extCounts.get(".ts") ?? 0) + (extCounts.get(".tsx") ?? 0) > 0) stack.push("typescript");
  if ((extCounts.get(".js") ?? 0) + (extCounts.get(".jsx") ?? 0) + (extCounts.get(".mjs") ?? 0) > 0) stack.push("javascript");
  if ((extCounts.get(".py") ?? 0) > 0) stack.push("python");
  if ((extCounts.get(".go") ?? 0) > 0) stack.push("go");
  if ((extCounts.get(".rs") ?? 0) > 0) stack.push("rust");
  if ((extCounts.get(".java") ?? 0) + (extCounts.get(".kt") ?? 0) > 0) stack.push("java/kotlin");
  if ((extCounts.get(".swift") ?? 0) > 0) stack.push("swift");
  if ((extCounts.get(".rb") ?? 0) > 0) stack.push("ruby");
  if ((extCounts.get(".php") ?? 0) > 0) stack.push("php");
  if ((extCounts.get(".c") ?? 0) + (extCounts.get(".cpp") ?? 0) > 0) stack.push("c/c++");
  if ((extCounts.get(".cs") ?? 0) > 0) stack.push("c#");
  if ((extCounts.get(".vue") ?? 0) > 0) stack.push("vue");
  if ((extCounts.get(".svelte") ?? 0) > 0) stack.push("svelte");

  // Framework detection from package.json
  if (packageJsonContent) {
    try {
      const pkg = JSON.parse(packageJsonContent);
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (allDeps.react || allDeps["react-dom"]) stack.push("react");
      if (allDeps.next) stack.push("next.js");
      if (allDeps.express) stack.push("express");
      if (allDeps.fastify) stack.push("fastify");
      if (allDeps.vitest) stack.push("vitest");
      if (allDeps.jest) stack.push("jest");
      if (allDeps.mocha) stack.push("mocha");
      if (allDeps.tailwindcss) stack.push("tailwindcss");
      if (allDeps.prisma || allDeps["@prisma/client"]) stack.push("prisma");
      if (allDeps.vite) stack.push("vite");
      if (allDeps.webpack) stack.push("webpack");
      if (allDeps.esbuild) stack.push("esbuild");
      if (allDeps.tsx) stack.push("tsx");
    } catch {
      // Invalid JSON — skip framework detection
    }
  }

  // Runtime detection
  if (existsSync(join(projectDir, "package.json"))) stack.push("node");
  if (existsSync(join(projectDir, "requirements.txt")) || existsSync(join(projectDir, "pyproject.toml"))) {
    if (!stack.includes("python")) stack.push("python");
  }
  if (existsSync(join(projectDir, "go.mod"))) {
    if (!stack.includes("go")) stack.push("go");
  }
  if (existsSync(join(projectDir, "Cargo.toml"))) {
    if (!stack.includes("rust")) stack.push("rust");
  }
  if (existsSync(join(projectDir, "Gemfile"))) {
    if (!stack.includes("ruby")) stack.push("ruby");
  }

  // Deduplicate
  return [...new Set(stack)];
}

// ── File prioritization for sampling ─────────────────────────────

/**
 * File priority for source sampling.
 * Lower number = higher priority (read first).
 */
export function filePriority(relPath: string): number {
  const base = basename(relPath).toLowerCase();
  const ext = extname(relPath).toLowerCase();

  // Test files highest priority (reveal project structure)
  if (base.includes(".test.") || base.includes(".spec.") || relPath.includes("__tests__")) {
    return 1;
  }

  // Entry points
  if (base === "index.ts" || base === "index.js" || base === "main.ts" || base === "main.js" ||
      base === "app.ts" || base === "app.js" || base === "cli.ts" || base === "cli.js" ||
      base === "server.ts" || base === "server.js") {
    return 2;
  }

  // Type definitions
  if (base === "types.ts" || base === "types.d.ts" || base.endsWith(".d.ts")) {
    return 3;
  }

  // Config files
  if (base.endsWith(".config.ts") || base.endsWith(".config.js") || base.endsWith(".config.mjs")) {
    return 4;
  }

  // Source files by extension — prefer code over data/style
  if ([".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".rb"].includes(ext)) {
    return 5;
  }

  return 10;
}

// ── Safe file reading ────────────────────────────────────────────

/**
 * Read a file safely, returning null on any error.
 * Skips binary files (checks first 512 bytes for null bytes).
 */
export function safeReadFile(filePath: string, maxBytes?: number): string | null {
  try {
    if (!existsSync(filePath)) return null;
    const stat = statSync(filePath);
    if (!stat.isFile()) return null;

    // Read with optional size limit — only read the bytes we need to avoid OOM on huge files
    if (maxBytes && stat.size > maxBytes) {
      const fd = openSync(filePath, "r");
      try {
        const buf = Buffer.alloc(maxBytes);
        const bytesRead = readSync(fd, buf, 0, maxBytes, 0);
        const content = buf.toString("utf-8", 0, bytesRead);
        // Binary check on bounded read
        if (content.slice(0, 512).includes("\0")) return null;
        return content;
      } finally {
        closeSync(fd);
      }
    }
    const content = readFileSync(filePath, "utf-8");

    // Binary check: if first 512 chars contain null bytes, skip
    const sample = content.slice(0, 512);
    if (sample.includes("\0")) return null;

    return content;
  } catch {
    return null;
  }
}

// ── Core analysis ────────────────────────────────────────────────

/**
 * Find CI configuration files.
 */
export function findCiConfig(projectDir: string): string | null {
  for (const pattern of CI_PATTERNS) {
    const fullPath = join(projectDir, pattern);
    if (!existsSync(fullPath)) continue;

    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        // Read first .yml/.yaml file in directory
        const entries = readdirSync(fullPath);
        const yamlFile = entries.find((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
        if (yamlFile) {
          return safeReadFile(join(fullPath, yamlFile));
        }
      } else {
        return safeReadFile(fullPath);
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Find the test directory path if one exists.
 */
export function findTestDir(projectDir: string, files: string[]): string | null {
  // Check common test directory names
  const testDirs = ["test", "tests", "__tests__", "spec", "specs"];
  for (const dir of testDirs) {
    if (existsSync(join(projectDir, dir))) return dir;
  }

  // Check if test files live alongside source (src/**/*.test.*)
  const testFiles = files.filter(
    (f) => f.includes(".test.") || f.includes(".spec.") || f.includes("__tests__"),
  );
  if (testFiles.length > 0) {
    // Find common parent
    const firstTest = testFiles[0];
    const parts = firstTest.split("/");
    return parts.length > 1 ? parts[0] : ".";
  }

  return null;
}

/**
 * Build the file tree string from collected file paths.
 * Truncates to fit within the token budget.
 */
export function buildFileTreeString(files: string[], budget: number): string {
  const fullText = files.join("\n");

  const tokens = estimateTokens(fullText);
  if (tokens <= budget) return fullText;

  // Reuse the generic truncation, then replace the suffix with a file-count message
  const truncated = truncateToTokenBudget(fullText, budget);
  // Remove the generic "... (truncated)" suffix and add file-count suffix
  const base = truncated.replace(/\n\.\.\. \(truncated\)$/, "");
  const shownCount = base.split("\n").length;
  return base + `\n... (${files.length - shownCount} more files, ${files.length} total)`;
}

/**
 * Truncate text to fit within a token budget.
 */
export function truncateToTokenBudget(text: string, budget: number): string {
  const tokens = estimateTokens(text);
  if (tokens <= budget) return text;

  const approxCharsPerToken = 3.5;
  const maxChars = Math.floor(budget * approxCharsPerToken);
  let result = text.slice(0, maxChars);

  // Trim to last complete line
  const lastNewline = result.lastIndexOf("\n");
  if (lastNewline > 0) {
    result = result.slice(0, lastNewline);
  }

  return result + "\n... (truncated)";
}

/**
 * Analyze a codebase to gather information for bootstrap prompt generation.
 * Runs entirely in TypeScript (no Claude tool calls).
 * Uses a tiered gathering strategy within the 50K token budget.
 */
export async function analyzeCodebase(projectDir: string): Promise<CodebaseAnalysis> {
  const errors: string[] = [];
  let tokensUsed = 0;

  // Check for existing artifacts
  const existingClaudeMd = existsSync(join(projectDir, "CLAUDE.md"));
  const existingTodosMd = existsSync(join(projectDir, "TODOS.md"));

  // Walk file tree
  const { files, truncated } = walkFileTree(projectDir);
  if (truncated) {
    errors.push(`File tree truncated at ${files.length} files (large repo)`);
  }

  // Filter to source files only (for counting and sampling)
  const sourceFiles = files.filter((f) => {
    const ext = extname(f).toLowerCase();
    return SOURCE_EXTENSIONS.has(ext) && !SKIP_EXTENSIONS.has(ext);
  });

  // Tier 1: Core config files (~2K tokens)
  let packageJson: string | null = null;
  const pkgPath = join(projectDir, "package.json");
  if (existsSync(pkgPath)) {
    packageJson = safeReadFile(pkgPath);
    if (packageJson) {
      const pkgTokens = estimateTokens(packageJson);
      if (pkgTokens > TIER1_BUDGET) {
        packageJson = truncateToTokenBudget(packageJson, TIER1_BUDGET);
      }
      tokensUsed += estimateTokens(packageJson);
    }
  }

  let tsConfig: string | null = null;
  const tsConfigPath = join(projectDir, "tsconfig.json");
  if (existsSync(tsConfigPath)) {
    tsConfig = safeReadFile(tsConfigPath);
    if (tsConfig) {
      tokensUsed += estimateTokens(tsConfig);
    }
  }

  const ciConfig = findCiConfig(projectDir);
  if (ciConfig) {
    tokensUsed += estimateTokens(ciConfig);
  }

  // Tier 2: README (up to 5K tokens)
  let readme: string | null = null;
  const readmeNames = ["README.md", "readme.md", "README", "README.txt", "README.rst"];
  for (const name of readmeNames) {
    const readmePath = join(projectDir, name);
    if (existsSync(readmePath)) {
      readme = safeReadFile(readmePath);
      if (readme) {
        const readmeTokens = estimateTokens(readme);
        if (readmeTokens > README_BUDGET) {
          readme = truncateToTokenBudget(readme, README_BUDGET);
        }
        tokensUsed += estimateTokens(readme);
      }
      break;
    }
  }

  // Tier 3: File tree listing (up to 5K tokens)
  const fileTreeStr = buildFileTreeString(files, FILE_TREE_BUDGET);
  tokensUsed += estimateTokens(fileTreeStr);

  // Detect tech stack
  const techStack = detectTechStack(projectDir, files, packageJson);

  // Find test directory
  const testDir = findTestDir(projectDir, files);

  // Tier 4: Sample source files (remaining budget)
  const remainingBudget = TOKEN_BUDGET - tokensUsed;
  const sampledFiles: Record<string, string> = {};

  if (remainingBudget > 0 && sourceFiles.length > 0) {
    // Sort by priority
    const sorted = [...sourceFiles].sort((a, b) => filePriority(a) - filePriority(b));

    let sampledTokens = 0;
    for (const relPath of sorted) {
      if (sampledTokens >= remainingBudget) break;

      const fullPath = join(projectDir, relPath);
      const content = safeReadFile(fullPath, 50_000); // max 50KB per file
      if (!content) continue;

      const fileTokens = estimateTokens(content);
      if (sampledTokens + fileTokens > remainingBudget) {
        // Try truncating this file to fit
        const available = remainingBudget - sampledTokens;
        if (available > 200) { // Only include if we can fit a meaningful chunk
          sampledFiles[relPath] = truncateToTokenBudget(content, available);
          sampledTokens += estimateTokens(sampledFiles[relPath]);
        }
        break;
      }

      sampledFiles[relPath] = content;
      sampledTokens += fileTokens;
    }

    tokensUsed += sampledTokens;
  }

  return {
    techStack,
    packageJson,
    tsConfig,
    ciConfig,
    readme,
    fileTree: fileTreeStr,
    testDir,
    sourceFiles: sampledFiles,
    existingClaudeMd,
    existingTodosMd,
    totalSourceFiles: sourceFiles.length,
    totalTokensGathered: tokensUsed,
    errors,
  };
}

// ── Prompt builder ──────────────────────────────────────────────

const CLAUDE_MD_INSTRUCTIONS = `## Generate CLAUDE.md

Write a \`CLAUDE.md\` file in the project root with this structure:

\`\`\`markdown
# [Project Name]

[1-2 sentence description of what the project does]

## Tech Stack

- **Runtime:** [e.g., Node.js / TypeScript (ESM)]
- **Framework:** [e.g., Next.js, Express, none]
- **Tests:** [e.g., Vitest, Jest, none found]
- **Build:** [e.g., tsc, esbuild, webpack, none]

## Architecture

[Brief description of the project structure — key directories, entry points,
data flow. 5-10 bullet points max.]

## Key Files

| File | Purpose |
|------|---------|
| [path] | [what it does] |

## Usage

\\\`\\\`\\\`bash
# How to install/build/test
[commands]
\\\`\\\`\\\`

## Development Notes

[Any patterns, conventions, or important notes discovered from the code]
\`\`\`

Be accurate. Only document what you can verify from the codebase analysis below.
Do not hallucinate file paths or features. If unsure about something, say "unclear from analysis."`;

const TODOS_MD_INSTRUCTIONS = `## Generate TODOS.md

Write a \`TODOS.md\` file in the project root. Each entry MUST use this exact format
(this format is parsed by automated tools — deviations will break the pipeline):

\`\`\`markdown
## P{N}: {Title}

**What:** {description of what needs to be done}
**Why:** {why this improves the project}
**Effort:** {XS|S|M|L|XL}
**Depends on:** {dependencies or "Nothing"}
\`\`\`

Where P{N} is the priority tier:
- P1: Critical — broken functionality, security issues, data loss risks
- P2: Important — significant quality improvements, missing core features
- P3: Moderate — nice-to-have improvements, code quality, minor features
- P4: Low — cosmetic issues, minor refactors, documentation gaps

Generate at least 5 items. Focus on:
1. **Missing tests** — files without test coverage
2. **Error handling** — missing try/catch, unhandled promises
3. **Code quality** — duplicated code, overly complex functions, outdated patterns
4. **Security** — hardcoded secrets, missing input validation, unsafe operations
5. **Documentation** — missing or outdated docs, unclear APIs
6. **Performance** — obvious bottlenecks, unnecessary re-renders, N+1 queries
7. **Dependencies** — outdated or vulnerable packages

Base items on concrete evidence from the codebase analysis. Each item should reference
specific files or patterns you observed. Do not generate vague or generic items.`;

const BOOTSTRAP_RULES = `## Rules

1. **Accuracy over completeness.** Only write what you can verify from the analysis. An accurate thin CLAUDE.md is better than a comprehensive hallucinated one.
2. **Concrete references.** Every TODOS.md item must reference specific files, functions, or patterns from the codebase.
3. **No modifications to existing files.** Only create new files (CLAUDE.md and/or TODOS.md).
4. **Correct format.** TODOS.md entries must exactly match the \`## P{N}: Title\` format — this is machine-parsed.
5. **Read more if needed.** You have access to Read/Glob/Grep tools. If the analysis below is insufficient, read additional files to fill gaps. But prioritize writing the output files.`;

/**
 * Build the bootstrap prompt from codebase analysis.
 *
 * Idempotency gate: if CLAUDE.md or TODOS.md already exist, their write
 * instructions are omitted from the prompt. If both exist, returns a
 * no-op prompt.
 */
export async function buildBootstrapPrompt(
  config: GaryClawConfig,
  previousSkills: PipelineSkillEntry[],
  projectDir: string,
): Promise<string> {
  const analysis = await analyzeCodebase(projectDir);
  const lines: string[] = [];

  // Check if there's anything to do
  if (analysis.existingClaudeMd && analysis.existingTodosMd) {
    lines.push(
      "Both CLAUDE.md and TODOS.md already exist in this project. " +
      "Nothing to bootstrap. Report that bootstrap is complete with no changes needed.",
    );
    return lines.join("\n");
  }

  // Role statement
  lines.push(
    "You are analyzing a codebase to bootstrap project artifacts for an autonomous development system. " +
    "Your job is to read the codebase analysis below and generate accurate project documentation.",
  );
  lines.push("");

  // What to generate
  if (!analysis.existingClaudeMd && !analysis.existingTodosMd) {
    lines.push("**Task:** Generate both `CLAUDE.md` and `TODOS.md` in the project root.");
  } else if (!analysis.existingClaudeMd) {
    lines.push("**Task:** Generate `CLAUDE.md` in the project root. (TODOS.md already exists — do not modify it.)");
  } else {
    lines.push("**Task:** Generate `TODOS.md` in the project root. (CLAUDE.md already exists — do not modify it.)");
  }
  lines.push("");

  // Codebase analysis
  lines.push("## Codebase Analysis");
  lines.push("");

  lines.push(`**Project directory:** \`${projectDir}\``);
  lines.push(`**Total source files:** ${analysis.totalSourceFiles}`);
  lines.push(`**Tech stack:** ${analysis.techStack.length > 0 ? analysis.techStack.join(", ") : "unknown"}`);
  if (analysis.testDir) {
    lines.push(`**Test directory:** ${analysis.testDir}`);
  }
  if (analysis.errors.length > 0) {
    lines.push(`**Analysis notes:** ${analysis.errors.join("; ")}`);
  }
  lines.push("");

  // Tier 1: Config files
  if (analysis.packageJson) {
    lines.push("### package.json");
    lines.push("```json");
    lines.push(analysis.packageJson);
    lines.push("```");
    lines.push("");
  }

  if (analysis.tsConfig) {
    lines.push("### tsconfig.json");
    lines.push("```json");
    lines.push(analysis.tsConfig);
    lines.push("```");
    lines.push("");
  }

  if (analysis.ciConfig) {
    lines.push("### CI Configuration");
    lines.push("```yaml");
    lines.push(analysis.ciConfig);
    lines.push("```");
    lines.push("");
  }

  // Tier 2: README
  if (analysis.readme) {
    lines.push("### README");
    lines.push("");
    lines.push(analysis.readme);
    lines.push("");
  }

  // Tier 3: File tree
  lines.push("### File Tree");
  lines.push("```");
  lines.push(analysis.fileTree);
  lines.push("```");
  lines.push("");

  // Tier 4: Source file samples
  const sampleEntries = Object.entries(analysis.sourceFiles);
  if (sampleEntries.length > 0) {
    lines.push("### Source File Samples");
    lines.push("");
    for (const [relPath, content] of sampleEntries) {
      const ext = extname(relPath).replace(".", "");
      lines.push(`#### ${relPath}`);
      lines.push(`\`\`\`${ext}`);
      lines.push(content);
      lines.push("```");
      lines.push("");
    }
  }

  // Instructions for what to generate
  if (!analysis.existingClaudeMd) {
    lines.push(CLAUDE_MD_INSTRUCTIONS);
    lines.push("");
  }

  if (!analysis.existingTodosMd) {
    lines.push(TODOS_MD_INSTRUCTIONS);
    lines.push("");
  }

  // Rules
  lines.push(BOOTSTRAP_RULES);
  lines.push("");

  return lines.join("\n");
}

// ── Enriched bootstrap prompt (quality gate re-bootstrap) ────────

/** Max tokens for existing CLAUDE.md content in enriched prompt. */
const ENRICHED_CLAUDE_MD_BUDGET = 5_000;

/**
 * Build an enriched bootstrap prompt for re-bootstrap after quality gate failure.
 *
 * Combines:
 * 1. Fresh codebase analysis (via analyzeCodebase)
 * 2. The existing (failed) CLAUDE.md content
 * 3. QA pre-scan findings from checkpoint
 *
 * All helper functions used already exist in bootstrap.ts and checkpoint.ts.
 */
export async function buildEnrichedBootstrapPrompt(
  config: GaryClawConfig,
  qaCheckpointDir: string,
  projectDir: string,
): Promise<string> {
  const analysis = await analyzeCodebase(projectDir);

  // Read existing CLAUDE.md (the one that failed the quality gate)
  let existingClaudeMd = "";
  try {
    existingClaudeMd = readFileSync(join(projectDir, "CLAUDE.md"), "utf-8");
  } catch { /* missing file is fine */ }

  // Truncate to budget if large
  if (existingClaudeMd && estimateTokens(existingClaudeMd) > ENRICHED_CLAUDE_MD_BUDGET) {
    existingClaudeMd = truncateToTokenBudget(existingClaudeMd, ENRICHED_CLAUDE_MD_BUDGET);
  }

  // Read QA findings from checkpoint (issues, findings from the pre-scan)
  const qaCheckpoint = readCheckpoint(qaCheckpointDir);
  const qaFindings = qaCheckpoint
    ? generateRelayPrompt(qaCheckpoint, { maxTokens: 5_000 })
    : "No QA findings captured.";

  // Format codebase analysis
  const fileTree = analysis.fileTree;

  return `You are improving a CLAUDE.md that scored below the quality threshold.

## Current CLAUDE.md (needs improvement)
${existingClaudeMd || "(empty — bootstrap produced no output)"}

## QA Pre-Scan Findings
${qaFindings}

## File Tree
${fileTree}

## Package Dependencies
${analysis.packageJson ?? "No package.json found."}

## Instructions
Rewrite CLAUDE.md to address the quality gaps. Include:
- All 4 required sections: Architecture, Tech Stack, Test Strategy, Usage
- Every framework/library found in package.json
- Specific file paths and module descriptions
- Any issues found by the QA pre-scan

Also update TODOS.md to include QA findings as backlog items with proper P1-P5 priorities.

Write the updated files now.`;
}
