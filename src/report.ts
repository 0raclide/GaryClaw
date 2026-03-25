/**
 * Report — merge results across relay sessions into a unified report.
 */

import type {
  Checkpoint,
  Issue,
  Finding,
  Decision,
  RunReport,
  RelayPoint,
} from "./types.js";

/**
 * Merge issues from multiple checkpoints. Dedup by id, later session wins on
 * status conflicts (e.g., if session 1 says "open" and session 2 says "fixed",
 * "fixed" wins).
 */
export function mergeIssues(checkpoints: Checkpoint[]): Issue[] {
  const issueMap = new Map<string, Issue>();
  for (const cp of checkpoints) {
    for (const issue of cp.issues) {
      issueMap.set(issue.id, issue);
    }
  }
  return Array.from(issueMap.values());
}

/**
 * Merge findings from multiple checkpoints. Dedup by normalized description.
 */
export function mergeFindings(checkpoints: Checkpoint[]): Finding[] {
  const seen = new Set<string>();
  const result: Finding[] = [];

  for (const cp of checkpoints) {
    for (const finding of cp.findings) {
      const key = finding.description.toLowerCase().trim();
      if (!seen.has(key)) {
        seen.add(key);
        result.push(finding);
      }
    }
  }

  return result;
}

/**
 * Merge decisions from multiple checkpoints. Concatenate (no dedup — every
 * decision is unique by timestamp).
 */
export function mergeDecisions(checkpoints: Checkpoint[]): Decision[] {
  const all: Decision[] = [];
  for (const cp of checkpoints) {
    all.push(...cp.decisions);
  }
  return all;
}

/**
 * Build a unified run report from all checkpoints and metadata.
 */
export function buildReport(
  checkpoints: Checkpoint[],
  metadata: {
    runId: string;
    skillName: string;
    startTime: string;
    endTime: string;
    totalSessions: number;
    totalTurns: number;
    estimatedCostUsd: number;
    relayPoints: RelayPoint[];
  },
): RunReport {
  return {
    runId: metadata.runId,
    skillName: metadata.skillName,
    startTime: metadata.startTime,
    endTime: metadata.endTime,
    totalSessions: metadata.totalSessions,
    totalTurns: metadata.totalTurns,
    estimatedCostUsd: metadata.estimatedCostUsd,
    issues: mergeIssues(checkpoints),
    findings: mergeFindings(checkpoints),
    decisions: mergeDecisions(checkpoints),
    relayPoints: metadata.relayPoints,
  };
}

/**
 * Format a report as human-readable markdown.
 */
export function formatReportMarkdown(report: RunReport): string {
  const lines: string[] = [];

  lines.push(`# GaryClaw Run Report — ${report.skillName}`);
  lines.push("");
  lines.push(`**Run ID:** ${report.runId}`);
  lines.push(`**Start:** ${report.startTime}`);
  lines.push(`**End:** ${report.endTime}`);
  lines.push(`**Sessions:** ${report.totalSessions} | **Turns:** ${report.totalTurns} | **Cost:** $${report.estimatedCostUsd.toFixed(3)}`);
  lines.push("");

  // Issues summary
  const open = report.issues.filter((i) => i.status === "open");
  const fixed = report.issues.filter((i) => i.status === "fixed");
  const skipped = report.issues.filter(
    (i) => i.status === "skipped" || i.status === "deferred",
  );

  lines.push(`## Issues Summary`);
  lines.push("");
  lines.push(`| Status | Count |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Open | ${open.length} |`);
  lines.push(`| Fixed | ${fixed.length} |`);
  lines.push(`| Skipped/Deferred | ${skipped.length} |`);
  lines.push(`| **Total** | **${report.issues.length}** |`);
  lines.push("");

  // Open issues
  if (open.length > 0) {
    lines.push(`## Open Issues (${open.length})`);
    lines.push("");
    for (const issue of open) {
      lines.push(`### ${issue.id} [${issue.severity}]`);
      lines.push(issue.description);
      if (issue.filePath) lines.push(`- File: ${issue.filePath}`);
      if (issue.screenshotPath) lines.push(`- Screenshot: ${issue.screenshotPath}`);
      lines.push("");
    }
  }

  // Fixed issues
  if (fixed.length > 0) {
    lines.push(`## Fixed Issues (${fixed.length})`);
    lines.push("");
    for (const issue of fixed) {
      lines.push(
        `- **${issue.id}** [${issue.severity}]: ${issue.description}${issue.fixCommit ? ` (${issue.fixCommit})` : ""}`,
      );
    }
    lines.push("");
  }

  // Findings
  if (report.findings.length > 0) {
    lines.push(`## Findings (${report.findings.length})`);
    lines.push("");
    for (const f of report.findings) {
      lines.push(`- **[${f.category}]** ${f.description}`);
      if (f.actionTaken) lines.push(`  - Action: ${f.actionTaken}`);
    }
    lines.push("");
  }

  // Relay points
  if (report.relayPoints.length > 0) {
    lines.push(`## Relay Points (${report.relayPoints.length})`);
    lines.push("");
    for (const rp of report.relayPoints) {
      lines.push(
        `- Session ${rp.sessionIndex} → ${rp.sessionIndex + 1}: ${rp.reason} (context: ${(rp.contextSize / 1000).toFixed(0)}K tokens)`,
      );
    }
    lines.push("");
  }

  // Decisions
  if (report.decisions.length > 0) {
    lines.push(`## Decisions (${report.decisions.length})`);
    lines.push("");
    for (const d of report.decisions) {
      lines.push(`- **Q:** ${d.question}`);
      lines.push(`  **A:** ${d.chosen} (confidence: ${d.confidence}/10) [${d.principle}]`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("*Generated by GaryClaw*");

  return lines.join("\n");
}
