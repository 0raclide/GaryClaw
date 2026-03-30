// Regression: ISSUE-005 — fleet display skill column overflow for long names
// Found by /qa on 2026-03-30
// Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-30.md
//
// Long skill names like "plan-eng-review 2/5" (20 chars) exceeded the 16-char
// SKILL column width, pushing TODO/TIME/COMMITS columns to the right and
// misaligning the table. Fix: truncate skillStr before padEnd.

import { describe, it, expect } from "vitest";

// Replicate truncateStr from cli.ts
function truncateStr(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + "…";
}

describe("fleet display skill column truncation", () => {
  const SKILL_COL_WIDTH = 16;
  const SKILL_MAX_DISPLAY = 15; // truncateStr target (leaves room for pad)

  function buildSkillStr(skillName: string, skillIdx: number, totalSkills: number): string {
    return truncateStr(`${skillName} ${skillIdx}/${totalSkills}`, SKILL_MAX_DISPLAY);
  }

  it("truncates plan-eng-review to fit within column", () => {
    const raw = "plan-eng-review 2/5";
    expect(raw.length).toBe(19); // confirms overflow before fix
    const result = buildSkillStr("plan-eng-review", 2, 5);
    expect(result.length).toBeLessThanOrEqual(SKILL_MAX_DISPLAY);
    expect(result).toBe("plan-eng-revie…");
  });

  it("does not truncate short skill names", () => {
    const result = buildSkillStr("qa", 1, 3);
    expect(result).toBe("qa 1/3");
    expect(result.length).toBeLessThan(SKILL_MAX_DISPLAY);
  });

  it("keeps implement within bounds", () => {
    const result = buildSkillStr("implement", 3, 5);
    expect(result).toBe("implement 3/5");
    expect(result.length).toBeLessThanOrEqual(SKILL_MAX_DISPLAY);
  });

  it("truncates office-hours with double-digit indices", () => {
    const result = buildSkillStr("office-hours", 10, 12);
    // "office-hours 10/12" = 18 chars > 15
    expect(result.length).toBeLessThanOrEqual(SKILL_MAX_DISPLAY);
    expect(result.endsWith("…")).toBe(true);
  });

  it("padEnd after truncation aligns to column width", () => {
    const result = buildSkillStr("plan-eng-review", 2, 5);
    const padded = result.padEnd(SKILL_COL_WIDTH);
    expect(padded.length).toBe(SKILL_COL_WIDTH);
  });

  it("preserves full name when it fits exactly", () => {
    // "prioritize 1/5" = 14 chars, fits in 15
    const result = buildSkillStr("prioritize", 1, 5);
    expect(result).toBe("prioritize 1/5");
    expect(result.length).toBe(14);
  });
});
