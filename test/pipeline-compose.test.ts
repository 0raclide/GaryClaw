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
    // XS selects implement+qa, custom-skill is not in selection, gets dropped
    expect(r.skills).toEqual(["implement", "qa"]);
  });

  it("requestedSkills with only non-standard skills returns them unchanged when composition selects implement+qa", () => {
    // Edge case: requestedSkills has no overlap with composition
    const r = compose({
      effort: "XS",
      priority: 5,
      requestedSkills: ["bootstrap", "evaluate"],
    });
    // Intersection is empty → falls back to original
    expect(r.skills).toEqual(["bootstrap", "evaluate"]);
    expect(r.reason).toContain("empty set");
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

  it("composed skills is always a subset of requestedSkills", () => {
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
