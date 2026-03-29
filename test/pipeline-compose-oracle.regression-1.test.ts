// Regression: oracle override skipped when oracle produces same-length but different skill set
// Found by /qa on 2026-03-29
// The guard `oracleComposed.length !== nextJob.skills.length` only compared counts,
// missing cases where oracle swaps skills (e.g., [office-hours, implement] vs [implement, qa]).

import { describe, it, expect } from "vitest";

describe("oracle override: same-length different-skills", () => {
  /**
   * Reproduce the exact guard logic from job-runner.ts (post-fix).
   * The fix adds `oracleComposed.some(s => !nextJob.skills.includes(s))`.
   */
  function shouldOverride(oracleComposed: string[], currentSkills: string[]): boolean {
    const isDifferentFromCurrent = oracleComposed.length !== currentSkills.length
      || oracleComposed.some(s => !currentSkills.includes(s));
    return oracleComposed.length > 0 && isDifferentFromCurrent;
  }

  it("detects override when oracle swaps skills at same count", () => {
    // Static gave [implement, qa], oracle wants [office-hours, implement]
    const oracleComposed = ["office-hours", "implement"];
    const currentSkills = ["implement", "qa"];

    expect(shouldOverride(oracleComposed, currentSkills)).toBe(true);
  });

  it("still treats identical sets as no-op", () => {
    const oracleComposed = ["implement", "qa"];
    const currentSkills = ["implement", "qa"];

    expect(shouldOverride(oracleComposed, currentSkills)).toBe(false);
  });

  it("still detects override when lengths differ", () => {
    const oracleComposed = ["office-hours", "implement", "qa"];
    const currentSkills = ["implement", "qa"];

    expect(shouldOverride(oracleComposed, currentSkills)).toBe(true);
  });

  it("handles empty oracle result as no-op", () => {
    const oracleComposed: string[] = [];
    const currentSkills = ["implement", "qa"];

    expect(shouldOverride(oracleComposed, currentSkills)).toBe(false);
  });
});
