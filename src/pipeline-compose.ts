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
  skipRiskScores?: Map<string, number>;  // from pipeline-history: skill -> risk score 0-1
  skipRiskThreshold?: number;            // default: 0.3 (from DEFAULT_SKIP_RISK_THRESHOLD)
}

export interface ComposeResult {
  skills: string[];            // composed skill sequence
  reason: string;              // human-readable explanation for logging
  savings: string;             // estimated savings vs full pipeline
  oracleRestoredSkills?: string[];  // skills restored by Oracle skip-risk (undefined if no Oracle adjustments)
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
 * remove known skills (those in FULL_PIPELINE), never add them.
 * Unknown skills (not in FULL_PIPELINE) pass through untouched.
 *
 * Returns the original requestedSkills unchanged if:
 * - requestedSkills has 0 or 1 skills (nothing to compose)
 * - Composition produces the same or longer skill list
 */
/** Default skip-risk threshold for Oracle restoration. */
const DEFAULT_SKIP_RISK_THRESHOLD = 0.3;

export function composePipeline(input: ComposeInput): ComposeResult {
  const { effort, priority, hasDesignDoc, requestedSkills, skipRiskScores, skipRiskThreshold } = input;

  // Nothing to compose with 0 or 1 skills
  if (requestedSkills.length <= 1) {
    return {
      skills: [...requestedSkills],
      reason: "single skill — no composition needed",
      savings: "$0.00",
    };
  }

  const { skills: selectedSkills, reason } = selectSkills(effort, priority, hasDesignDoc);

  // Intersect: for skills the static table knows about, keep only those in selectedSkills.
  // For skills the table doesn't recognize (gstack skills like plan-design-review,
  // design-review, etc.), pass them through untouched — the user explicitly requested them.
  const knownSkills = new Set(FULL_PIPELINE);
  const composed = requestedSkills.filter(s =>
    !knownSkills.has(s) || selectedSkills.includes(s),
  );

  // If intersection is empty (shouldn't happen since implement+qa are always present),
  // fall back to requestedSkills
  if (composed.length === 0) {
    return {
      skills: [...requestedSkills],
      reason: "composition produced empty set — using original",
      savings: "$0.00",
    };
  }

  // ── Oracle skip-risk restoration ─────────────────────────────────
  // After static rules, check if any removed skills have high skip-risk.
  // Oracle can only ADD skills back that static rules removed — never remove
  // skills that static rules kept. This makes the system strictly safer.
  const oracleRestoredSkills: string[] = [];
  if (skipRiskScores && skipRiskScores.size > 0) {
    const threshold = skipRiskThreshold ?? DEFAULT_SKIP_RISK_THRESHOLD;
    const removedSkills = requestedSkills.filter(s => !composed.includes(s));

    for (const skill of removedSkills) {
      const risk = skipRiskScores.get(skill);
      if (risk !== undefined && risk > threshold) {
        oracleRestoredSkills.push(skill);
      }
    }

    // Re-insert restored skills in their original order from requestedSkills
    if (oracleRestoredSkills.length > 0) {
      const finalSkills: string[] = [];
      for (const s of requestedSkills) {
        if (composed.includes(s) || oracleRestoredSkills.includes(s)) {
          finalSkills.push(s);
        }
      }

      const restoredDetail = oracleRestoredSkills
        .map(s => `${s}(${(skipRiskScores.get(s)! * 100).toFixed(0)}%)`)
        .join(", ");

      const originalCost = requestedSkills.reduce((sum, s) => sum + (SKILL_COST_USD[s] ?? 0.50), 0);
      const finalCost = finalSkills.reduce((sum, s) => sum + (SKILL_COST_USD[s] ?? 0.50), 0);
      const savings = Math.max(0, originalCost - finalCost);

      return {
        skills: finalSkills,
        reason: `${reason} + Oracle restored [${restoredDetail}]`,
        savings: `$${savings.toFixed(2)}`,
        oracleRestoredSkills,
      };
    }
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
