/**
 * Pipeline Composition — adaptive skill selection based on task metadata.
 *
 * Maps (effort, priority, hasDesignDoc) to a minimal skill sequence via
 * a static lookup table. Intersects with requestedSkills to ensure we
 * never add skills the trigger didn't request.
 *
 * Pure function, no I/O — all state passed in via ComposeInput.
 */

// ── Types ─────────────────────────────────────────────────────────

export interface ComposeInput {
  effort: string | null;       // from TodoItem.effort: XS/S/M/L/XL
  priority: number;            // from TodoItem.priority: 1-5 (1 = highest)
  hasDesignDoc: boolean;       // design doc already exists
  requestedSkills: string[];   // original trigger skills (the "maximum")
}

export interface ComposeResult {
  skills: string[];            // composed skill sequence
  reason: string;              // human-readable explanation for logging
  savings: string;             // estimated savings vs full pipeline
}

// ── Full pipeline (reference) ─────────────────────────────────────

const FULL_PIPELINE = ["prioritize", "office-hours", "implement", "plan-eng-review", "qa"];

// ── Average cost per skill (rough estimates for savings calculation) ─

const SKILL_COST_USD: Record<string, number> = {
  prioritize: 0.30,
  "office-hours": 0.80,
  implement: 1.50,
  "plan-eng-review": 0.60,
  qa: 0.80,
};

// ── Composition rules ─────────────────────────────────────────────

/**
 * Select the minimal skill sequence for a given task.
 *
 * Rules (priority order):
 * - XS effort: implement -> qa (trivial change, no design needed)
 * - S effort, P4-P5: implement -> qa (low priority, small change)
 * - S effort, P2-P3, no design doc: office-hours -> implement -> qa
 * - S effort, P2-P3, has design doc: implement -> plan-eng-review -> qa
 * - S effort, P1: full pipeline (critical priority = full rigor)
 * - M effort, has design doc: implement -> plan-eng-review -> qa
 * - M effort, no design doc: full pipeline
 * - L/XL effort: full pipeline
 * - null/unknown effort: full pipeline (be conservative)
 */
function selectSkills(effort: string | null, priority: number, hasDesignDoc: boolean): { skills: string[]; reason: string } {
  const e = effort?.toUpperCase() ?? null;

  // XS: always minimal
  if (e === "XS") {
    return { skills: ["implement", "qa"], reason: "XS effort — minimal pipeline" };
  }

  // S effort
  if (e === "S") {
    if (priority >= 4) {
      return { skills: ["implement", "qa"], reason: "S effort, low priority (P4+) — minimal pipeline" };
    }
    if (priority >= 2 && priority <= 3) {
      if (hasDesignDoc) {
        return { skills: ["implement", "plan-eng-review", "qa"], reason: "S effort, P2-P3, has design doc — skip office-hours" };
      }
      return { skills: ["office-hours", "implement", "qa"], reason: "S effort, P2-P3, no design doc — needs design thinking" };
    }
    // P1: full pipeline
    return { skills: FULL_PIPELINE, reason: "S effort, P1 — critical priority, full rigor" };
  }

  // M effort
  if (e === "M") {
    if (hasDesignDoc) {
      return { skills: ["implement", "plan-eng-review", "qa"], reason: "M effort, has design doc — skip design phase" };
    }
    return { skills: FULL_PIPELINE, reason: "M effort, no design doc — full pipeline" };
  }

  // L/XL: full pipeline
  if (e === "L" || e === "XL") {
    return { skills: FULL_PIPELINE, reason: `${e} effort — full pipeline` };
  }

  // null/unknown: conservative
  return { skills: FULL_PIPELINE, reason: "unknown effort — full pipeline (conservative)" };
}

// ── Main composition function ─────────────────────────────────────

/**
 * Compose a minimal pipeline from task metadata.
 *
 * The composed list is intersected with requestedSkills to ensure we
 * never ADD skills the trigger didn't request. Composition can only
 * remove skills, never add them.
 *
 * Returns the original requestedSkills unchanged if:
 * - requestedSkills has 0 or 1 skills (nothing to compose)
 * - Composition produces the same or longer skill list
 */
export function composePipeline(input: ComposeInput): ComposeResult {
  const { effort, priority, hasDesignDoc, requestedSkills } = input;

  // Nothing to compose with 0 or 1 skills
  if (requestedSkills.length <= 1) {
    return {
      skills: [...requestedSkills],
      reason: "single skill — no composition needed",
      savings: "$0.00",
    };
  }

  const { skills: selectedSkills, reason } = selectSkills(effort, priority, hasDesignDoc);

  // Intersect: keep only skills that are in both selectedSkills AND requestedSkills,
  // preserving the order from requestedSkills
  const composed = requestedSkills.filter(s => selectedSkills.includes(s));

  // If intersection is empty (shouldn't happen since implement+qa are always present),
  // fall back to requestedSkills
  if (composed.length === 0) {
    return {
      skills: [...requestedSkills],
      reason: "composition produced empty set — using original",
      savings: "$0.00",
    };
  }

  // Calculate estimated savings
  const originalCost = requestedSkills.reduce((sum, s) => sum + (SKILL_COST_USD[s] ?? 0.50), 0);
  const composedCost = composed.reduce((sum, s) => sum + (SKILL_COST_USD[s] ?? 0.50), 0);
  const savings = Math.max(0, originalCost - composedCost);

  return {
    skills: composed,
    reason,
    savings: `$${savings.toFixed(2)}`,
  };
}
