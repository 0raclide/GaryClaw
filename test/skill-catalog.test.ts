import { describe, it, expect } from "vitest";
import { SKILL_CATALOG, formatSkillCatalogForPrompt, type SkillEntry } from "../src/skill-catalog.js";

// ── Cost values from pipeline-compose.ts SKILL_COST_USD (not exported) ──
const PIPELINE_COMPOSE_COSTS: Record<string, number> = {
  prioritize: 0.30,
  "office-hours": 0.80,
  implement: 1.50,
  "plan-eng-review": 0.60,
  qa: 0.80,
};

// ── Catalog structure validation ─────────────────────────────────

describe("SKILL_CATALOG structure", () => {
  it("has at least 10 entries", () => {
    expect(SKILL_CATALOG.length).toBeGreaterThanOrEqual(10);
  });

  it("every entry has all required fields", () => {
    for (const entry of SKILL_CATALOG) {
      expect(typeof entry.name).toBe("string");
      expect(entry.name.length).toBeGreaterThan(0);
      expect(typeof entry.description).toBe("string");
      expect(entry.description.length).toBeGreaterThan(0);
      expect(typeof entry.useWhen).toBe("string");
      expect(entry.useWhen.length).toBeGreaterThan(0);
      expect(typeof entry.produces).toBe("string");
      expect(entry.produces.length).toBeGreaterThan(0);
      expect(typeof entry.costUsd).toBe("number");
      expect(entry.costUsd).toBeGreaterThan(0);
      expect(["plan", "exec"]).toContain(entry.mode);
    }
  });

  it("has no duplicate skill names", () => {
    const names = SKILL_CATALOG.map(s => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("contains the 5 core pipeline skills", () => {
    const names = SKILL_CATALOG.map(s => s.name);
    expect(names).toContain("prioritize");
    expect(names).toContain("office-hours");
    expect(names).toContain("implement");
    expect(names).toContain("plan-eng-review");
    expect(names).toContain("qa");
  });

  it("contains extended skills beyond the core 5", () => {
    const names = SKILL_CATALOG.map(s => s.name);
    expect(names).toContain("design-review");
    expect(names).toContain("plan-ceo-review");
    expect(names).toContain("plan-design-review");
    expect(names).toContain("bootstrap");
    expect(names).toContain("evaluate");
  });
});

// ── Cost sync with pipeline-compose.ts ───────────────────────────

describe("SKILL_CATALOG cost sync with SKILL_COST_USD", () => {
  it("catalog costs match pipeline-compose.ts costs for overlapping skills", () => {
    for (const [skillName, expectedCost] of Object.entries(PIPELINE_COMPOSE_COSTS)) {
      const entry = SKILL_CATALOG.find(s => s.name === skillName);
      expect(entry, `skill "${skillName}" missing from catalog`).toBeDefined();
      expect(entry!.costUsd).toBe(expectedCost);
    }
  });
});

// ── Mode grouping ────────────────────────────────────────────────

describe("SKILL_CATALOG mode grouping", () => {
  it("plan-mode skills produce review findings or design docs", () => {
    const planSkills = SKILL_CATALOG.filter(s => s.mode === "plan");
    expect(planSkills.length).toBeGreaterThanOrEqual(3);
    for (const s of planSkills) {
      expect(s.name).toMatch(/plan-|office-hours/);
    }
  });

  it("exec-mode skills produce code or artifacts", () => {
    const execSkills = SKILL_CATALOG.filter(s => s.mode === "exec");
    expect(execSkills.length).toBeGreaterThanOrEqual(5);
    expect(execSkills.map(s => s.name)).toContain("implement");
    expect(execSkills.map(s => s.name)).toContain("qa");
  });
});

// ── formatSkillCatalogForPrompt ──────────────────────────────────

describe("formatSkillCatalogForPrompt", () => {
  it("returns non-empty string", () => {
    const output = formatSkillCatalogForPrompt();
    expect(output.length).toBeGreaterThan(0);
  });

  it("contains Review Skills and Execution Skills sections", () => {
    const output = formatSkillCatalogForPrompt();
    expect(output).toContain("### Review Skills");
    expect(output).toContain("### Execution Skills");
  });

  it("contains markdown table headers", () => {
    const output = formatSkillCatalogForPrompt();
    expect(output).toContain("| Skill | Description | Use When | Produces | Cost |");
  });

  it("includes all catalog skills in the output", () => {
    const output = formatSkillCatalogForPrompt();
    for (const entry of SKILL_CATALOG) {
      expect(output).toContain(entry.name);
    }
  });

  it("includes cost with dollar formatting", () => {
    const output = formatSkillCatalogForPrompt();
    expect(output).toContain("$0.30");
    expect(output).toContain("$1.50");
  });

  it("stays under 2000 tokens", () => {
    const output = formatSkillCatalogForPrompt();
    // Conservative: ~3.5 chars per token (same as estimateTokens in checkpoint.ts)
    const estimatedTokens = Math.ceil(output.length / 3.5);
    expect(estimatedTokens).toBeLessThan(2000);
  });

  it("groups plan-mode skills before exec-mode skills", () => {
    const output = formatSkillCatalogForPrompt();
    const reviewIdx = output.indexOf("### Review Skills");
    const execIdx = output.indexOf("### Execution Skills");
    expect(reviewIdx).toBeLessThan(execIdx);
  });
});
