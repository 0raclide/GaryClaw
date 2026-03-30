import { describe, it, expect } from "vitest";
import { composePipeline, type ComposeInput, type ComposeResult } from "../src/pipeline-compose.js";

// ── Helpers ───────────────────────────────────────────────────────

const FULL_PIPELINE = ["prioritize", "office-hours", "implement", "plan-eng-review", "qa"];

function compose(overrides: Partial<ComposeInput> = {}): ComposeResult {
  return composePipeline({
    effort: null,
    priority: 3,
    hasDesignDoc: false,
    requestedSkills: [...FULL_PIPELINE],
    ...overrides,
  });
}

// ── XS effort ─────────────────────────────────────────────────────

describe("composePipeline — XS effort", () => {
  it("XS, any priority, no design doc → implement + qa", () => {
    const r = compose({ effort: "XS", priority: 3 });
    expect(r.skills).toEqual(["implement", "qa"]);
    expect(r.reason).toContain("XS");
  });

  it("XS, any priority, has design doc → implement + qa", () => {
    const r = compose({ effort: "XS", priority: 3, hasDesignDoc: true });
    expect(r.skills).toEqual(["implement", "qa"]);
  });

  it("XS, P1 → implement + qa (XS overrides P1)", () => {
    const r = compose({ effort: "XS", priority: 1 });
    expect(r.skills).toEqual(["implement", "qa"]);
  });

  it("XS, P5 → implement + qa", () => {
    const r = compose({ effort: "XS", priority: 5 });
    expect(r.skills).toEqual(["implement", "qa"]);
  });

  it("XS is case-insensitive", () => {
    const r = compose({ effort: "xs" });
    expect(r.skills).toEqual(["implement", "qa"]);
  });
});

// ── S effort ──────────────────────────────────────────────────────

describe("composePipeline — S effort", () => {
  it("S, P4, no design doc → implement + qa", () => {
    const r = compose({ effort: "S", priority: 4 });
    expect(r.skills).toEqual(["implement", "qa"]);
    expect(r.reason).toContain("low priority");
  });

  it("S, P5, no design doc → implement + qa", () => {
    const r = compose({ effort: "S", priority: 5 });
    expect(r.skills).toEqual(["implement", "qa"]);
  });

  it("S, P4, has design doc → implement + qa", () => {
    const r = compose({ effort: "S", priority: 4, hasDesignDoc: true });
    expect(r.skills).toEqual(["implement", "qa"]);
  });

  it("S, P2, no design doc → office-hours + implement + qa", () => {
    const r = compose({ effort: "S", priority: 2 });
    expect(r.skills).toEqual(["office-hours", "implement", "qa"]);
    expect(r.reason).toContain("needs design thinking");
  });

  it("S, P3, no design doc → office-hours + implement + qa", () => {
    const r = compose({ effort: "S", priority: 3 });
    expect(r.skills).toEqual(["office-hours", "implement", "qa"]);
  });

  it("S, P2, has design doc → implement + plan-eng-review + qa", () => {
    const r = compose({ effort: "S", priority: 2, hasDesignDoc: true });
    expect(r.skills).toEqual(["implement", "plan-eng-review", "qa"]);
    expect(r.reason).toContain("skip office-hours");
  });

  it("S, P3, has design doc → implement + plan-eng-review + qa", () => {
    const r = compose({ effort: "S", priority: 3, hasDesignDoc: true });
    expect(r.skills).toEqual(["implement", "plan-eng-review", "qa"]);
  });

  it("S, P1, no design doc → full pipeline", () => {
    const r = compose({ effort: "S", priority: 1 });
    expect(r.skills).toEqual(FULL_PIPELINE);
    expect(r.reason).toContain("P1");
  });

  it("S, P1, has design doc → full pipeline", () => {
    const r = compose({ effort: "S", priority: 1, hasDesignDoc: true });
    expect(r.skills).toEqual(FULL_PIPELINE);
  });
});

// ── M effort ──────────────────────────────────────────────────────

describe("composePipeline — M effort", () => {
  it("M, no design doc → full pipeline", () => {
    const r = compose({ effort: "M", priority: 3 });
    expect(r.skills).toEqual(FULL_PIPELINE);
    expect(r.reason).toContain("full pipeline");
  });

  it("M, has design doc → implement + plan-eng-review + qa", () => {
    const r = compose({ effort: "M", priority: 3, hasDesignDoc: true });
    expect(r.skills).toEqual(["implement", "plan-eng-review", "qa"]);
    expect(r.reason).toContain("skip design phase");
  });

  it("M, P1, has design doc → implement + plan-eng-review + qa", () => {
    const r = compose({ effort: "M", priority: 1, hasDesignDoc: true });
    expect(r.skills).toEqual(["implement", "plan-eng-review", "qa"]);
  });
});

// ── L/XL effort ───────────────────────────────────────────────────

describe("composePipeline — L/XL effort", () => {
  it("L, no design doc → full pipeline", () => {
    const r = compose({ effort: "L", priority: 3 });
    expect(r.skills).toEqual(FULL_PIPELINE);
  });

  it("L, has design doc → full pipeline", () => {
    const r = compose({ effort: "L", priority: 3, hasDesignDoc: true });
    expect(r.skills).toEqual(FULL_PIPELINE);
  });

  it("XL, no design doc → full pipeline", () => {
    const r = compose({ effort: "XL", priority: 3 });
    expect(r.skills).toEqual(FULL_PIPELINE);
    expect(r.reason).toContain("XL");
  });

  it("XL, has design doc → full pipeline", () => {
    const r = compose({ effort: "XL", priority: 3, hasDesignDoc: true });
    expect(r.skills).toEqual(FULL_PIPELINE);
  });
});

// ── null/unknown effort ───────────────────────────────────────────

describe("composePipeline — null/unknown effort", () => {
  it("null effort → full pipeline (conservative)", () => {
    const r = compose({ effort: null });
    expect(r.skills).toEqual(FULL_PIPELINE);
    expect(r.reason).toContain("conservative");
  });

  it("unknown effort string → full pipeline", () => {
    const r = compose({ effort: "XXXL" });
    expect(r.skills).toEqual(FULL_PIPELINE);
    expect(r.reason).toContain("unknown");
  });

  it("empty string effort → full pipeline", () => {
    const r = compose({ effort: "" });
    expect(r.skills).toEqual(FULL_PIPELINE);
  });
});

// ── Intersection with requestedSkills ─────────────────────────────

describe("composePipeline — intersection logic", () => {
  it("drops composed skills not in requestedSkills", () => {
    // requestedSkills is just implement+qa, so office-hours from S/P2 rule is dropped
    const r = compose({
      effort: "S",
      priority: 2,
      requestedSkills: ["implement", "qa"],
    });
    expect(r.skills).toEqual(["implement", "qa"]);
  });

  it("preserves requestedSkills order", () => {
    // Weird order in requestedSkills should be preserved
    const r = compose({
      effort: "M",
      priority: 3,
      hasDesignDoc: true,
      requestedSkills: ["qa", "plan-eng-review", "implement"],
    });
    expect(r.skills).toEqual(["qa", "plan-eng-review", "implement"]);
  });

  it("partial requestedSkills: only implement+qa in trigger", () => {
    const r = compose({
      effort: "M",
      priority: 3,
      requestedSkills: ["implement", "qa"],
    });
    // Full pipeline selected, but intersected down to implement+qa
    expect(r.skills).toEqual(["implement", "qa"]);
  });

  it("non-standard skills pass through if in full pipeline selection", () => {
    // requestedSkills includes a custom skill not in the composition table
    const r = compose({
      effort: "XS",
      priority: 5,
      requestedSkills: ["implement", "qa", "custom-skill"],
    });
    // XS selects implement+qa, custom-skill is unknown to table so passes through
    expect(r.skills).toEqual(["implement", "qa", "custom-skill"]);
  });

  it("requestedSkills with only non-standard skills all pass through", () => {
    // Edge case: requestedSkills has no overlap with composition table
    const r = compose({
      effort: "XS",
      priority: 5,
      requestedSkills: ["bootstrap", "evaluate"],
    });
    // Both are unknown to the static table, so both pass through
    expect(r.skills).toEqual(["bootstrap", "evaluate"]);
  });

  it("design skills survive composition for UI tasks", () => {
    // The bug that prompted this fix: plan-design-review and design-review
    // were stripped because they're not in FULL_PIPELINE
    const r = compose({
      effort: null,
      priority: 1,
      requestedSkills: ["prioritize", "office-hours", "plan-design-review", "implement", "design-review", "qa"],
    });
    // Unknown effort → full pipeline, but design skills pass through
    expect(r.skills).toContain("plan-design-review");
    expect(r.skills).toContain("design-review");
    expect(r.skills).toContain("implement");
    expect(r.skills).toContain("qa");
  });
});

// ── Edge cases ────────────────────────────────────────────────────

describe("composePipeline — edge cases", () => {
  it("single skill → no composition", () => {
    const r = compose({ effort: "XS", requestedSkills: ["qa"] });
    expect(r.skills).toEqual(["qa"]);
    expect(r.reason).toContain("single skill");
  });

  it("empty requestedSkills → no composition", () => {
    const r = compose({ effort: "XS", requestedSkills: [] });
    expect(r.skills).toEqual([]);
    expect(r.reason).toContain("single skill");
  });

  it("two skills → can still compose", () => {
    const r = compose({
      effort: "XS",
      requestedSkills: ["implement", "qa"],
    });
    expect(r.skills).toEqual(["implement", "qa"]);
  });

  it("priority 0 treated as P1-like (< 2)", () => {
    const r = compose({ effort: "S", priority: 0 });
    // priority 0 < 2, doesn't match P4+ or P2-P3, falls to P1 branch
    expect(r.skills).toEqual(FULL_PIPELINE);
  });

  it("priority 6 treated as low priority (P4+)", () => {
    const r = compose({ effort: "S", priority: 6 });
    expect(r.skills).toEqual(["implement", "qa"]);
  });
});

// ── Savings calculation ───────────────────────────────────────────

describe("composePipeline — savings", () => {
  it("XS savings reflects skipped skills", () => {
    const r = compose({ effort: "XS" });
    // Skips prioritize ($0.30), office-hours ($0.80), plan-eng-review ($0.60)
    expect(r.savings).toBe("$1.70");
  });

  it("full pipeline has $0.00 savings", () => {
    const r = compose({ effort: "L" });
    expect(r.savings).toBe("$0.00");
  });

  it("single skill has $0.00 savings", () => {
    const r = compose({ effort: "XS", requestedSkills: ["qa"] });
    expect(r.savings).toBe("$0.00");
  });

  it("S/P2 with design doc → savings from skipping prioritize + office-hours", () => {
    const r = compose({ effort: "S", priority: 2, hasDesignDoc: true });
    // Skips prioritize ($0.30) and office-hours ($0.80)
    expect(r.savings).toBe("$1.10");
  });
});

// ── Invariants ────────────────────────────────────────────────────

describe("composePipeline — invariants", () => {
  it("implement is always present when in requestedSkills", () => {
    const efforts = ["XS", "S", "M", "L", "XL", null];
    const priorities = [1, 2, 3, 4, 5];
    for (const effort of efforts) {
      for (const priority of priorities) {
        for (const hasDesignDoc of [true, false]) {
          const r = compose({ effort, priority, hasDesignDoc });
          expect(r.skills).toContain("implement");
        }
      }
    }
  });

  it("qa is always present when in requestedSkills", () => {
    const efforts = ["XS", "S", "M", "L", "XL", null];
    const priorities = [1, 2, 3, 4, 5];
    for (const effort of efforts) {
      for (const priority of priorities) {
        for (const hasDesignDoc of [true, false]) {
          const r = compose({ effort, priority, hasDesignDoc });
          expect(r.skills).toContain("qa");
        }
      }
    }
  });

  it("composed skills is always a subset of requestedSkills (known skills only)", () => {
    const efforts = ["XS", "S", "M", "L", "XL", null];
    const priorities = [1, 2, 3, 4, 5];
    for (const effort of efforts) {
      for (const priority of priorities) {
        const r = compose({ effort, priority });
        for (const skill of r.skills) {
          expect(FULL_PIPELINE).toContain(skill);
        }
      }
    }
  });

  it("composed skills is always a subset of requestedSkills (with unknown skills)", () => {
    const efforts = ["XS", "S", "M", "L", "XL", null];
    const priorities = [1, 2, 3, 4, 5];
    const requested = [...FULL_PIPELINE, "design-review", "plan-design-review"];
    for (const effort of efforts) {
      for (const priority of priorities) {
        const r = compose({ effort, priority, requestedSkills: requested });
        for (const skill of r.skills) {
          expect(requested).toContain(skill);
        }
      }
    }
  });

  it("composed length is never greater than requestedSkills length", () => {
    const efforts = ["XS", "S", "M", "L", "XL", null, "XXXL"];
    for (const effort of efforts) {
      const r = compose({ effort });
      expect(r.skills.length).toBeLessThanOrEqual(FULL_PIPELINE.length);
    }
  });
});

// ── Result shape ──────────────────────────────────────────────────

describe("composePipeline — result shape", () => {
  it("always returns skills, reason, and savings", () => {
    const r = compose();
    expect(r).toHaveProperty("skills");
    expect(r).toHaveProperty("reason");
    expect(r).toHaveProperty("savings");
    expect(Array.isArray(r.skills)).toBe(true);
    expect(typeof r.reason).toBe("string");
    expect(r.savings).toMatch(/^\$\d+\.\d{2}$/);
  });

  it("reason is non-empty", () => {
    const r = compose({ effort: "XS" });
    expect(r.reason.length).toBeGreaterThan(0);
  });
});

// ── Oracle skip-risk restoration ─────────────────────────────────

describe("composePipeline — Oracle skip-risk restoration", () => {
  it("no skipRiskScores → no Oracle adjustment", () => {
    const r = compose({ effort: "XS" });
    expect(r.oracleRestoredSkills).toBeUndefined();
    expect(r.skills).toEqual(["implement", "qa"]);
  });

  it("empty skipRiskScores → no Oracle adjustment", () => {
    const r = compose({ effort: "XS", skipRiskScores: new Map() });
    expect(r.oracleRestoredSkills).toBeUndefined();
  });

  it("low skip-risk scores → no restoration", () => {
    const scores = new Map([["office-hours", 0.1], ["plan-eng-review", 0.05]]);
    const r = compose({ effort: "XS", skipRiskScores: scores });
    expect(r.skills).toEqual(["implement", "qa"]);
    expect(r.oracleRestoredSkills).toBeUndefined();
  });

  it("high skip-risk restores skill", () => {
    const scores = new Map([["plan-eng-review", 0.5]]);
    const r = compose({ effort: "XS", skipRiskScores: scores });
    expect(r.skills).toContain("plan-eng-review");
    expect(r.oracleRestoredSkills).toEqual(["plan-eng-review"]);
  });

  it("restored skills maintain original order from requestedSkills", () => {
    const scores = new Map([
      ["office-hours", 0.4],
      ["plan-eng-review", 0.6],
    ]);
    const r = compose({ effort: "XS", skipRiskScores: scores });
    // XS removes everything except implement+qa. Both restored.
    // Original order: prioritize, office-hours, implement, plan-eng-review, qa
    expect(r.skills).toEqual(["office-hours", "implement", "plan-eng-review", "qa"]);
    expect(r.oracleRestoredSkills).toEqual(["office-hours", "plan-eng-review"]);
  });

  it("reason includes Oracle restoration detail", () => {
    const scores = new Map([["office-hours", 0.45]]);
    const r = compose({ effort: "XS", skipRiskScores: scores });
    expect(r.reason).toContain("Oracle restored");
    expect(r.reason).toContain("office-hours");
    expect(r.reason).toContain("45%");
  });

  it("respects custom skipRiskThreshold", () => {
    const scores = new Map([["office-hours", 0.25]]);
    // Default threshold is 0.3, so 0.25 would NOT trigger
    const r1 = compose({ effort: "XS", skipRiskScores: scores });
    expect(r1.oracleRestoredSkills).toBeUndefined();

    // With lower threshold of 0.2, 0.25 SHOULD trigger
    const r2 = compose({ effort: "XS", skipRiskScores: scores, skipRiskThreshold: 0.2 });
    expect(r2.oracleRestoredSkills).toEqual(["office-hours"]);
  });

  it("only restores skills that static rules removed (not already-included skills)", () => {
    // S/P2/no design doc → office-hours, implement, qa (plan-eng-review removed)
    const scores = new Map([
      ["office-hours", 0.9],     // already included — should NOT appear in restored
      ["plan-eng-review", 0.5],  // was removed — should be restored
    ]);
    const r = compose({ effort: "S", priority: 2, hasDesignDoc: false, skipRiskScores: scores });
    expect(r.skills).toContain("plan-eng-review");
    expect(r.oracleRestoredSkills).toEqual(["plan-eng-review"]);
  });

  it("skip-risk at exactly threshold is NOT restored (> not >=)", () => {
    const scores = new Map([["office-hours", 0.3]]);
    const r = compose({ effort: "XS", skipRiskScores: scores });
    expect(r.oracleRestoredSkills).toBeUndefined();
  });

  it("savings recalculated after Oracle restoration", () => {
    // XS normally saves $1.70 (skips prioritize, office-hours, plan-eng-review)
    // Restoring office-hours ($0.80) reduces savings to $0.90
    const scores = new Map([["office-hours", 0.5]]);
    const r = compose({ effort: "XS", skipRiskScores: scores });
    expect(r.savings).toBe("$0.90");
  });

  it("Oracle cannot restore skills not in requestedSkills", () => {
    // requestedSkills only has implement+qa, skip-risk for office-hours irrelevant
    const scores = new Map([["office-hours", 0.9]]);
    const r = compose({
      effort: "XS",
      requestedSkills: ["implement", "qa"],
      skipRiskScores: scores,
    });
    expect(r.skills).toEqual(["implement", "qa"]);
    expect(r.oracleRestoredSkills).toBeUndefined();
  });

  it("single skill bypasses Oracle restoration", () => {
    const scores = new Map([["qa", 0.9]]);
    const r = compose({ effort: "XS", requestedSkills: ["qa"], skipRiskScores: scores });
    expect(r.skills).toEqual(["qa"]);
    expect(r.oracleRestoredSkills).toBeUndefined();
  });

  it("full pipeline has nothing to restore", () => {
    const scores = new Map([["office-hours", 0.9]]);
    const r = compose({ effort: "L", skipRiskScores: scores });
    // L effort → full pipeline, nothing was removed
    expect(r.skills).toEqual(FULL_PIPELINE);
    expect(r.oracleRestoredSkills).toBeUndefined();
  });
});
