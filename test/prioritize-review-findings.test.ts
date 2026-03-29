/**
 * Regression: loadUnresolvedReviewFindings — zero prior test coverage.
 * Found by /qa on 2026-03-29.
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-29.md
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadUnresolvedReviewFindings } from "../src/prioritize.js";

const TEST_DIR = join(process.cwd(), ".test-prioritize-review-tmp");

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("loadUnresolvedReviewFindings", () => {
  it("returns empty array when no jobs directory exists", () => {
    const result = loadUnresolvedReviewFindings(TEST_DIR);
    expect(result).toEqual([]);
  });

  it("returns empty array when jobs dir is empty", () => {
    mkdirSync(join(TEST_DIR, "jobs"), { recursive: true });
    const result = loadUnresolvedReviewFindings(TEST_DIR);
    expect(result).toEqual([]);
  });

  it("returns empty array when job has no pipeline-report.md", () => {
    const jobDir = join(TEST_DIR, "jobs", "job-2026-03-29-001");
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(join(jobDir, "state.json"), "{}");
    const result = loadUnresolvedReviewFindings(TEST_DIR);
    expect(result).toEqual([]);
  });

  it("extracts findings from flat job layout with review skill report", () => {
    const jobDir = join(TEST_DIR, "jobs", "job-2026-03-29-001");
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(
      join(jobDir, "pipeline-report.md"),
      [
        "# Pipeline Report",
        "",
        "## /plan-eng-review",
        "",
        "### Decisions",
        "",
        "- **Q:** Should we add input validation to the login form? → **A:** Fix the validation — add zod schema for all fields (8/10)",
        "- **Q:** Should we add rate limiting? → **A:** Skip for now, not critical (7/10)",
      ].join("\n"),
    );

    const result = loadUnresolvedReviewFindings(TEST_DIR);
    expect(result.length).toBe(1);
    expect(result[0].accepted).toBe("Fix the validation — add zod schema for all fields");
    expect(result[0].confidence).toBe(8);
    expect(result[0].jobId).toBe("job-2026-03-29-001");
  });

  it("extracts findings from instance-based layout (daemons/name/jobs/)", () => {
    const jobDir = join(TEST_DIR, "daemons", "worker-1", "jobs", "job-2026-03-29-002");
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(
      join(jobDir, "pipeline-report.md"),
      [
        "# Pipeline Report",
        "",
        "## /plan-ceo-review",
        "",
        "- **Q:** Missing error page for 404 → **A:** Implement a custom 404 page with navigation (9/10)",
      ].join("\n"),
    );

    const result = loadUnresolvedReviewFindings(TEST_DIR);
    expect(result.length).toBe(1);
    expect(result[0].accepted).toBe("Implement a custom 404 page with navigation");
    expect(result[0].confidence).toBe(9);
  });

  it("scans both flat and instance layouts", () => {
    // Flat layout
    const flatJob = join(TEST_DIR, "jobs", "job-001");
    mkdirSync(flatJob, { recursive: true });
    writeFileSync(
      join(flatJob, "pipeline-report.md"),
      "## /plan-eng-review\n\n- **Q:** Q1 → **A:** Implement retry logic (7/10)",
    );

    // Instance layout
    const instJob = join(TEST_DIR, "daemons", "bot", "jobs", "job-002");
    mkdirSync(instJob, { recursive: true });
    writeFileSync(
      join(instJob, "pipeline-report.md"),
      "## /plan-eng-review\n\n- **Q:** Q2 → **A:** Add timeout handling (8/10)",
    );

    const result = loadUnresolvedReviewFindings(TEST_DIR);
    expect(result.length).toBe(2);
  });

  it("filters out non-action decisions (skip, proceed, etc.)", () => {
    const jobDir = join(TEST_DIR, "jobs", "job-001");
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(
      join(jobDir, "pipeline-report.md"),
      [
        "## /plan-eng-review",
        "",
        "- **Q:** Ready to ship? → **A:** Skip for now (9/10)",
        "- **Q:** Run tests? → **A:** Proceed with the test suite (8/10)",
        "- **Q:** Missing validation → **A:** Fix the input validation (7/10)",
      ].join("\n"),
    );

    const result = loadUnresolvedReviewFindings(TEST_DIR);
    expect(result.length).toBe(1);
    expect(result[0].accepted).toContain("Fix the input validation");
  });

  it("ignores reports without review skill markers", () => {
    const jobDir = join(TEST_DIR, "jobs", "job-001");
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(
      join(jobDir, "pipeline-report.md"),
      [
        "## /qa",
        "",
        "- **Q:** Fix the bug? → **A:** Implement the fix immediately (9/10)",
      ].join("\n"),
    );

    const result = loadUnresolvedReviewFindings(TEST_DIR);
    expect(result).toEqual([]);
  });

  it("takes only the 10 most recent job dirs (sorted by name)", () => {
    // Create 12 flat jobs
    for (let i = 0; i < 12; i++) {
      const id = String(i).padStart(3, "0");
      const jobDir = join(TEST_DIR, "jobs", `job-${id}`);
      mkdirSync(jobDir, { recursive: true });
      writeFileSync(
        join(jobDir, "pipeline-report.md"),
        `## /plan-eng-review\n\n- **Q:** Q${i} → **A:** Fix item ${i} (7/10)`,
      );
    }

    const result = loadUnresolvedReviewFindings(TEST_DIR);
    // Should only process 10 most recent (002-011), not 000-001
    expect(result.length).toBeLessThanOrEqual(10);
    // Most recent jobs are 011, 010, 009... (reverse sorted)
    expect(result.some((f) => f.jobId === "job-011")).toBe(true);
    expect(result.some((f) => f.jobId === "job-002")).toBe(true);
  });

  it("handles action keywords: implement, add, build now, extract, validate, replace", () => {
    const jobDir = join(TEST_DIR, "jobs", "job-001");
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(
      join(jobDir, "pipeline-report.md"),
      [
        "## /plan-eng-review",
        "",
        "- **Q:** Q1 → **A:** Implement the cache layer (8/10)",
        "- **Q:** Q2 → **A:** Add error boundaries (7/10)",
        "- **Q:** Q3 → **A:** Extract shared utils (6/10)",
        "- **Q:** Q4 → **A:** Validate all inputs (9/10)",
        "- **Q:** Q5 → **A:** Replace the old parser (7/10)",
      ].join("\n"),
    );

    const result = loadUnresolvedReviewFindings(TEST_DIR);
    expect(result.length).toBe(5);
  });

  it("gracefully handles corrupt or unreadable job directories", () => {
    // Create a normal job
    const goodJob = join(TEST_DIR, "jobs", "job-002");
    mkdirSync(goodJob, { recursive: true });
    writeFileSync(
      join(goodJob, "pipeline-report.md"),
      "## /plan-eng-review\n\n- **Q:** Q1 → **A:** Fix the auth flow (8/10)",
    );

    // Create a job with no report (should be skipped, not crash)
    const emptyJob = join(TEST_DIR, "jobs", "job-001");
    mkdirSync(emptyJob, { recursive: true });

    const result = loadUnresolvedReviewFindings(TEST_DIR);
    expect(result.length).toBe(1);
    expect(result[0].accepted).toContain("Fix the auth flow");
  });
});
