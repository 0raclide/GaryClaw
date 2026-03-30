import { describe, it, expect } from "vitest";
import { formatUptime } from "../src/cli.js";
import type { PipelineProgress } from "../src/types.js";

describe("formatUptime", () => {
  it("formats seconds", () => {
    expect(formatUptime(45)).toBe("45s");
  });

  it("formats minutes and seconds", () => {
    expect(formatUptime(125)).toBe("2m 5s");
  });

  it("formats hours and minutes", () => {
    expect(formatUptime(3725)).toBe("1h 2m");
  });

  it("formats zero", () => {
    expect(formatUptime(0)).toBe("0s");
  });
});

describe("PipelineProgress interface", () => {
  it("constructs a valid PipelineProgress object", () => {
    const pp: PipelineProgress = {
      currentSkill: "implement",
      skillIndex: 1,
      totalSkills: 4,
      claimedTodoTitle: "Self-Commit Filtering",
      elapsedSeconds: 720,
      commitCount: 3,
    };
    expect(pp.currentSkill).toBe("implement");
    expect(pp.skillIndex).toBe(1);
    expect(pp.totalSkills).toBe(4);
    expect(pp.claimedTodoTitle).toBe("Self-Commit Filtering");
    expect(pp.elapsedSeconds).toBe(720);
    expect(pp.commitCount).toBe(3);
  });

  it("allows null claimedTodoTitle", () => {
    const pp: PipelineProgress = {
      currentSkill: "prioritize",
      skillIndex: 0,
      totalSkills: 4,
      claimedTodoTitle: null,
      elapsedSeconds: 30,
      commitCount: 0,
    };
    expect(pp.claimedTodoTitle).toBeNull();
  });
});

describe("fleet display formatting helpers", () => {
  it("truncates long strings with ellipsis", () => {
    // Inline test of the truncation logic used in displayAllInstances
    function truncateStr(s: string, maxLen: number): string {
      if (s.length <= maxLen) return s;
      return s.slice(0, maxLen - 1) + "…";
    }
    expect(truncateStr("Short", 26)).toBe("Short");
    const truncated = truncateStr("A very long TODO title that exceeds the limit", 26);
    expect(truncated.length).toBe(26);
    expect(truncated.endsWith("…")).toBe(true);
    expect(truncateStr("Exactly26CharactersLong!!!", 26)).toBe("Exactly26CharactersLong!!!");
  });

  it("formatElapsed handles seconds", () => {
    // Inline test matching the formatElapsed function in cli.ts
    function formatElapsed(seconds: number): string {
      if (seconds < 60) return `${seconds}s`;
      if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      return `${h}h ${m}m`;
    }
    expect(formatElapsed(30)).toBe("30s");
    expect(formatElapsed(125)).toBe("2m");
    expect(formatElapsed(7325)).toBe("2h 2m");
    expect(formatElapsed(0)).toBe("0s");
  });
});
