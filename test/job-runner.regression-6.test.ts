/**
 * Regression: ISSUE-001 — 'continuous' trigger source must be valid on Job.triggeredBy
 * Found by /qa on 2026-03-29
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-29.md
 *
 * The continuous pipeline re-enqueue feature (commit b8c5ac8) passed "continuous"
 * as triggeredBy but the Job interface union type didn't include it, causing a
 * TypeScript compile error (TS2345). Fix: added "continuous" to the union.
 */

import { describe, it, expect } from "vitest";
import type { Job } from "../src/types.js";

describe("Job.triggeredBy includes continuous", () => {
  it("accepts 'continuous' as a valid triggeredBy value", () => {
    const job: Pick<Job, "triggeredBy"> = { triggeredBy: "continuous" };
    expect(job.triggeredBy).toBe("continuous");
  });

  it("still accepts all original trigger sources", () => {
    const sources: Job["triggeredBy"][] = [
      "git_poll",
      "cron",
      "manual",
      "auto_research",
      "continuous",
    ];
    expect(sources).toHaveLength(5);
    for (const s of sources) {
      const job: Pick<Job, "triggeredBy"> = { triggeredBy: s };
      expect(job.triggeredBy).toBe(s);
    }
  });
});
