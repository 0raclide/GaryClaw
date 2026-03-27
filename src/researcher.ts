/**
 * Domain Expertise Research — researches topics via web search and persists
 * structured findings in domain-expertise.md for future Oracle decisions.
 *
 * Features:
 * - Freshness tracking: skip re-research within 14-day window (configurable)
 * - Structured output: YAML frontmatter + markdown sections per topic
 * - Graceful degradation: WebSearch unavailable → return existing content unchanged
 * - Token budget enforcement: oldest topics dropped when over 20K token budget
 * - Read-only canUseTool: only WebSearch, WebFetch, Read allowed during research
 */

import type {
  DomainSection,
  OracleMemoryConfig,
  CanUseToolResult,
} from "./types.js";
import { ORACLE_MEMORY_BUDGETS } from "./types.js";
import { readOracleMemory, writeDomainExpertise } from "./oracle-memory.js";
import { estimateTokens } from "./checkpoint.js";

// ── Config ──────────────────────────────────────────────────────

export interface ResearchConfig {
  topic: string;
  projectDir: string;
  maxSearches: number;        // default: 10
  timeoutMs: number;          // default: 300_000 (5 min)
  force: boolean;             // ignore freshness, re-research
  oracleMemoryConfig: OracleMemoryConfig;
}

export interface ResearchResult {
  topic: string;
  sectionsFound: number;
  searchesUsed: number;
  partial: boolean;
  freshUntil: string;         // ISO timestamp
  skipped: boolean;           // true if topic was fresh and --force not used
  costUsd: number;            // SDK session cost (from result message)
}

// ── Constants ───────────────────────────────────────────────────

const DEFAULT_FRESHNESS_DAYS = 14;

/** Tools allowed during research sessions (read-only + web) */
const ALLOWED_TOOLS = new Set(["WebSearch", "WebFetch", "Read"]);

// ── Main entry point ────────────────────────────────────────────

/**
 * Run domain expertise research for a given topic.
 *
 * Flow:
 * 1. Read existing domain-expertise.md
 * 2. Check freshness — skip if < 14 days old (unless force)
 * 3. Start SDK session with research prompt + read-only canUseTool
 * 4. Extract structured findings from SDK output
 * 5. Merge into domain-expertise.md respecting token budget
 * 6. Write updated file
 *
 * @param config Research configuration
 * @param startSegmentFn SDK segment starter (injected for testability)
 */
export async function runResearch(
  config: ResearchConfig,
  startSegmentFn: (options: {
    prompt: string;
    maxTurns: number;
    cwd: string;
    env: Record<string, string>;
    settingSources: string[];
    canUseTool: (toolName: string, input: Record<string, unknown>) => Promise<CanUseToolResult>;
  }) => AsyncIterable<{ type: string; [key: string]: unknown }>,
): Promise<ResearchResult> {
  // Read existing domain expertise
  const memoryFiles = readOracleMemory(config.oracleMemoryConfig, config.projectDir);
  const existingContent = memoryFiles.domainExpertise;
  const existingSections = existingContent ? parseDomainSections(existingContent) : [];

  // Check freshness
  if (!config.force && !isTopicStale(existingContent, config.topic)) {
    const existingSection = existingSections.find(
      (s) => s.topic.toLowerCase() === config.topic.toLowerCase(),
    );
    const freshUntil = existingSection
      ? new Date(new Date(existingSection.lastResearched).getTime() + DEFAULT_FRESHNESS_DAYS * 86_400_000).toISOString()
      : new Date().toISOString();

    return {
      topic: config.topic,
      sectionsFound: existingSections.length,
      searchesUsed: 0,
      partial: existingSection?.partial ?? false,
      freshUntil,
      skipped: true,
      costUsd: 0,
    };
  }

  // Build research prompt
  const existingKnowledge = existingSections
    .find((s) => s.topic.toLowerCase() === config.topic.toLowerCase())
    ?.content ?? null;
  const prompt = buildResearchPrompt(config.topic, existingKnowledge);

  // Run SDK session with timeout + AbortController for clean cancellation
  let resultText = "";
  let searchesUsed = 0;
  let costUsd = 0;
  let timedOut = false;

  const abortController = new AbortController();
  const timeoutTimer = setTimeout(() => {
    abortController.abort();
  }, config.timeoutMs);

  try {
    const segment = startSegmentFn({
      prompt,
      maxTurns: config.maxSearches,
      cwd: config.projectDir,
      env: {},
      settingSources: ["user", "project"],
      canUseTool: async (toolName: string, _input: Record<string, unknown>) => {
        // Deny all tool calls after timeout to break the SDK out of its loop
        if (abortController.signal.aborted) {
          return { behavior: "deny" as const, message: "Research timeout exceeded" };
        }
        return createResearchCanUseTool(toolName);
      },
    });

    for await (const msg of segment) {
      // Check abort signal between messages
      if (abortController.signal.aborted) {
        timedOut = true;
        break;
      }

      if (msg.type === "assistant") {
        // Count search tool uses
        const content = (msg as any).message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "tool_use" && (block.name === "WebSearch" || block.name === "WebFetch")) {
              searchesUsed++;
            }
          }
        }
      }
      if (msg.type === "result") {
        if ((msg as any).subtype === "success") {
          resultText = (msg as any).result ?? "";
        }
        // Extract cost from result message (same field as extractResultData)
        const totalCost = (msg as any).total_cost_usd;
        if (typeof totalCost === "number") {
          costUsd = totalCost;
        }
      }
    }
  } catch (err) {
    // Check if this was an abort-triggered error
    if (abortController.signal.aborted) {
      timedOut = true;
    } else if (!resultText) {
      // WebSearch unavailable or other SDK error — graceful degradation
      // No results at all — return existing content unchanged
      return {
        topic: config.topic,
        sectionsFound: existingSections.length,
        searchesUsed: 0,
        partial: true,
        freshUntil: new Date().toISOString(),
        skipped: false,
        costUsd,
      };
    }
  } finally {
    clearTimeout(timeoutTimer);
  }

  // Parse and merge results
  const isPartial = timedOut || !resultText;
  const newSection: DomainSection = {
    topic: config.topic,
    lastResearched: new Date().toISOString(),
    searchCount: searchesUsed,
    partial: isPartial,
    content: resultText || "(No results — WebSearch may be unavailable)",
  };

  const mergedContent = mergeDomainSections(
    existingSections,
    newSection,
    ORACLE_MEMORY_BUDGETS.domainExpertise,
  );

  // Write merged content
  writeDomainExpertise(config.oracleMemoryConfig, mergedContent);

  const freshUntil = new Date(
    new Date(newSection.lastResearched).getTime() + DEFAULT_FRESHNESS_DAYS * 86_400_000,
  ).toISOString();

  return {
    topic: config.topic,
    sectionsFound: parseDomainSections(mergedContent).length,
    searchesUsed,
    partial: isPartial,
    freshUntil,
    skipped: false,
    costUsd,
  };
}

// ── Freshness check ─────────────────────────────────────────────

/**
 * Check if a topic needs re-research.
 * Returns true if:
 * - No existing domain expertise content
 * - Topic not found in existing content
 * - Topic's lastResearched is older than freshnessWindowDays
 */
export function isTopicStale(
  domainExpertise: string | null,
  topic: string,
  freshnessWindowDays: number = DEFAULT_FRESHNESS_DAYS,
): boolean {
  if (!domainExpertise) return true;

  const sections = parseDomainSections(domainExpertise);
  const section = sections.find(
    (s) => s.topic.toLowerCase() === topic.toLowerCase(),
  );

  if (!section) return true;

  const lastResearched = new Date(section.lastResearched);
  if (isNaN(lastResearched.getTime())) return true;

  const now = new Date();
  const ageDays = (now.getTime() - lastResearched.getTime()) / 86_400_000;

  return ageDays >= freshnessWindowDays;
}

// ── Section parsing ─────────────────────────────────────────────

/**
 * Parse domain-expertise.md into topic sections.
 * Each section starts with YAML frontmatter delimited by `---`.
 *
 * Format:
 * ```
 * ---
 * topic: ...
 * last_researched: ...
 * search_count: ...
 * partial: ...
 * ---
 *
 * ## Current SOTA
 * ...
 * ```
 */
export function parseDomainSections(content: string): DomainSection[] {
  if (!content || !content.trim()) return [];

  const sections: DomainSection[] = [];

  // Split on "---" delimiter, then pair frontmatter + body chunks.
  // This avoids complex regex lookaheads and handles any YAML field order.
  const chunks = content.split("\n---\n");

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i].trim();
    // Skip chunks that don't look like frontmatter (e.g., the file header)
    if (!chunk.includes("topic:")) continue;

    // This chunk is frontmatter; the next chunk (if any) is the body
    const frontmatter = chunk;
    const body = (i + 1 < chunks.length ? chunks[i + 1] : "").trim();

    // If body itself contains topic: it's actually another frontmatter block, not a body
    const isBodyActuallyFrontmatter = body.includes("topic:") && body.includes("last_researched:");

    const topic = extractYamlField(frontmatter, "topic");
    const lastResearched = extractYamlField(frontmatter, "last_researched");
    const searchCount = parseInt(extractYamlField(frontmatter, "search_count") || "0", 10);
    const partial = extractYamlField(frontmatter, "partial") === "true";

    if (topic) {
      sections.push({
        topic,
        lastResearched: lastResearched || new Date().toISOString(),
        searchCount: isNaN(searchCount) ? 0 : searchCount,
        partial,
        content: isBodyActuallyFrontmatter ? "" : body,
      });
      // Skip the body chunk since we consumed it
      if (!isBodyActuallyFrontmatter && body) i++;
    }
  }

  return sections;
}

/**
 * Extract a YAML field value from frontmatter text.
 */
function extractYamlField(frontmatter: string, field: string): string {
  const regex = new RegExp(`^${field}:\\s*(.+)$`, "m");
  const match = frontmatter.match(regex);
  return match ? match[1].trim() : "";
}

// ── Section merging ─────────────────────────────────────────────

/**
 * Merge a new research section into existing domain-expertise.md.
 *
 * Rules:
 * - New topic: append section
 * - Existing topic: replace section with fresh data
 * - Respect token budget (drop oldest topics first)
 */
export function mergeDomainSections(
  existing: DomainSection[],
  newSection: DomainSection,
  tokenBudget: number,
): string {
  // Replace existing topic or append new
  const existingIndex = existing.findIndex(
    (s) => s.topic.toLowerCase() === newSection.topic.toLowerCase(),
  );

  let merged: DomainSection[];
  if (existingIndex >= 0) {
    merged = [...existing];
    merged[existingIndex] = newSection;
  } else {
    merged = [...existing, newSection];
  }

  // Format all sections
  let content = formatDomainSections(merged);

  // Enforce token budget — drop oldest topics first
  while (estimateTokens(content) > tokenBudget && merged.length > 1) {
    // Find oldest section (by lastResearched)
    let oldestIdx = 0;
    let oldestDate = new Date(merged[0].lastResearched).getTime();

    for (let i = 1; i < merged.length; i++) {
      const date = new Date(merged[i].lastResearched).getTime();
      if (date < oldestDate) {
        oldestDate = date;
        oldestIdx = i;
      }
    }

    // Don't drop the section we just added
    if (merged[oldestIdx].topic.toLowerCase() === newSection.topic.toLowerCase() && merged.length > 1) {
      // Drop second-oldest instead
      merged.splice(oldestIdx === 0 ? 1 : oldestIdx, 1);
    } else {
      merged.splice(oldestIdx, 1);
    }

    content = formatDomainSections(merged);
  }

  return content;
}

/**
 * Format domain sections back into markdown with YAML frontmatter.
 */
function formatDomainSections(sections: DomainSection[]): string {
  if (sections.length === 0) return "# Domain Expertise\n";

  return (
    "# Domain Expertise\n\n" +
    sections
      .map(
        (s) =>
          `---\ntopic: ${s.topic}\nlast_researched: ${s.lastResearched}\nsearch_count: ${s.searchCount}\npartial: ${s.partial}\n---\n\n${s.content}`,
      )
      .join("\n\n")
  );
}

// ── Research prompt ─────────────────────────────────────────────

/**
 * Build the research prompt for the SDK session.
 */
export function buildResearchPrompt(
  topic: string,
  existingKnowledge: string | null,
): string {
  let prompt = `You are a domain expertise researcher. Your job is to research "${topic}" and produce a structured summary.

Use WebSearch to find current, authoritative information. Focus on:
1. Current state of the art (SOTA)
2. What works well in practice (with specifics)
3. What doesn't work or common pitfalls
4. Key references (URLs)

`;

  if (existingKnowledge) {
    prompt += `## Existing Knowledge (may be outdated)
${existingKnowledge}

Update this with current information. Correct anything outdated. Add new findings.

`;
  }

  prompt += `## Output Format
Respond with ONLY the research content in this exact format (no YAML frontmatter — that will be added automatically):

## Current SOTA
- [bullet points with specifics]

## What Works
- [bullet points with specifics, numbers, versions]

## What Doesn't
- [bullet points with specifics, reasons why]

## Key References
- [Title](URL)

Keep each section concise. Focus on actionable, implementation-relevant information.
Do NOT include any YAML frontmatter or --- delimiters. Just the markdown content sections.`;

  return prompt;
}

// ── canUseTool for research ─────────────────────────────────────

/**
 * Create a canUseTool callback for research sessions.
 * Only allows read-only tools + WebSearch/WebFetch.
 */
export async function createResearchCanUseTool(toolName: string): Promise<CanUseToolResult> {
  if (ALLOWED_TOOLS.has(toolName)) {
    return { behavior: "allow" };
  }
  return {
    behavior: "deny",
    message: `Research mode: only WebSearch, WebFetch, and Read are allowed (denied: ${toolName})`,
  };
}
