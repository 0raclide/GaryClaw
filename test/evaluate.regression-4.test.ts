/**
 * Regression: ISSUE-001 — parseClaudeImprovements skips earlier valid blocks
 * Found by /qa on 2026-03-28
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-28.md
 *
 * When the last <improvements> block parses as a valid JSON array but zero
 * items pass field validation (e.g., all have invalid priorities), the function
 * returned [] without trying earlier blocks that might contain valid items.
 * The fix: only short-circuit when valid.length > 0.
 */

import { describe, it, expect } from "vitest";
import { parseClaudeImprovements } from "../src/evaluate.js";

describe("parseClaudeImprovements last-valid-match edge case", () => {
  it("falls through to earlier block when last block has valid JSON but zero qualifying items", () => {
    // Block 1: valid items with correct priority (P3)
    // Block 2: valid JSON array, but P1 priority is not in VALID_PRIORITIES
    const output = `First segment:
<improvements>
[{"title": "Good improvement", "priority": "P3", "effort": "XS", "category": "oracle", "description": "Valid", "evidence": "Real data"}]
</improvements>
Second segment (relay):
<improvements>
[{"title": "Bad priority", "priority": "P1", "effort": "S", "category": "bootstrap", "description": "X", "evidence": "Y"}]
</improvements>`;

    const result = parseClaudeImprovements(output);
    // Should fall through the last block (zero qualifying items) and return the first block's items
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Good improvement");
  });

  it("falls through empty array block to earlier valid block", () => {
    // Block 1: valid items
    // Block 2: valid JSON but empty array
    const output = `First:
<improvements>
[{"title": "Found something", "priority": "P2", "effort": "S", "category": "pipeline", "description": "Needs fix", "evidence": "Evidence here"}]
</improvements>
Second:
<improvements>
[]
</improvements>`;

    const result = parseClaudeImprovements(output);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Found something");
  });

  it("returns [] when all blocks have valid JSON but zero qualifying items", () => {
    const output = `First:
<improvements>
[{"title": "Bad1", "priority": "P1", "effort": "S", "category": "bootstrap", "description": "X", "evidence": "Y"}]
</improvements>
Second:
<improvements>
[{"title": "Bad2", "priority": "P0", "effort": "XL", "category": "unknown", "description": "X", "evidence": "Y"}]
</improvements>`;

    const result = parseClaudeImprovements(output);
    expect(result).toEqual([]);
  });

  it("prefers last valid block when both have qualifying items", () => {
    // Original behavior: last-to-first, return first with qualifying items
    const output = `First:
<improvements>
[{"title": "First block item", "priority": "P3", "effort": "XS", "category": "oracle", "description": "A", "evidence": "B"}]
</improvements>
Second:
<improvements>
[{"title": "Second block item", "priority": "P2", "effort": "S", "category": "pipeline", "description": "C", "evidence": "D"}]
</improvements>`;

    const result = parseClaudeImprovements(output);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Second block item");
  });
});
