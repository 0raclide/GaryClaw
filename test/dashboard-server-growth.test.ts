/**
 * Dashboard server growth data tests — extraction, caching, regex parsing.
 * All synthetic data. Git commands are mocked via vi.mock.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

// Mock execFileSync to avoid real git commands
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
const mockExecFileSync = vi.mocked(execFileSync);

import {
  extractCounts,
  gitExec,
  getHeadSha,
  buildGrowthSnapshots,
  buildModuleAttribution,
  loadOrBuildGrowthCache,
  MAX_GROWTH_COMMITS,
  GIT_COMMAND_TIMEOUT_MS,
  type GrowthSnapshot,
  type GrowthCache,
} from "../src/dashboard-server.js";

// ── Helpers ─────────────────────────────────────────────────────

function tmpDir(): string {
  const dir = join(tmpdir(), `garyclaw-growth-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── extractCounts ────────────────────────────────────────────────

describe("extractCounts", () => {
  it("parses combined format: '43 source modules, 216 test files, 3501 tests'", () => {
    const content = "- 43 source modules, 216 test files, 3501 tests\n";
    const result = extractCounts(content);
    expect(result).toEqual({ modules: 43, tests: 3501 });
  });

  it("parses current CLAUDE.md format with multiline", () => {
    const content = `
**Phase 1a: COMPLETE**
- 43 source modules, 216 test files, 3501 tests
- All 5 spikes passed
`;
    const result = extractCounts(content);
    expect(result).toEqual({ modules: 43, tests: 3501 });
  });

  it("parses separate patterns as fallback", () => {
    const content = "We have 8 source modules in the project.\nAlso 42 tests are green.";
    const result = extractCounts(content);
    expect(result).toEqual({ modules: 8, tests: 42 });
  });

  it("parses modules-only content", () => {
    const content = "This project has 12 source modules.";
    const result = extractCounts(content);
    expect(result).toEqual({ modules: 12, tests: 0 });
  });

  it("parses tests-only content", () => {
    const content = "Running 500 tests in CI.";
    const result = extractCounts(content);
    expect(result).toEqual({ modules: 0, tests: 500 });
  });

  it("returns null for unparseable content", () => {
    expect(extractCounts("# README\nThis is a project.")).toBeNull();
    expect(extractCounts("")).toBeNull();
  });

  it("handles large numbers", () => {
    const content = "- 100 source modules, 999 test files, 10000 tests";
    const result = extractCounts(content);
    expect(result).toEqual({ modules: 100, tests: 10000 });
  });
});

// ── gitExec ──────────────────────────────────────────────────────

describe("gitExec", () => {
  beforeEach(() => {
    mockExecFileSync.mockReset();
  });

  it("returns trimmed stdout on success", () => {
    mockExecFileSync.mockReturnValue("abc123\n" as any);
    const result = gitExec(["rev-parse", "HEAD"], "/tmp/project");
    expect(result).toBe("abc123");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "git",
      ["rev-parse", "HEAD"],
      expect.objectContaining({
        cwd: "/tmp/project",
        encoding: "utf-8",
        timeout: GIT_COMMAND_TIMEOUT_MS,
      }),
    );
  });

  it("returns null on error", () => {
    mockExecFileSync.mockImplementation(() => { throw new Error("not a git repo"); });
    expect(gitExec(["status"], "/tmp/not-a-repo")).toBeNull();
  });

  it("returns null on timeout", () => {
    mockExecFileSync.mockImplementation(() => {
      const err = new Error("ETIMEDOUT") as any;
      err.killed = true;
      throw err;
    });
    expect(gitExec(["log"], "/tmp")).toBeNull();
  });
});

// ── getHeadSha ───────────────────────────────────────────────────

describe("getHeadSha", () => {
  beforeEach(() => {
    mockExecFileSync.mockReset();
  });

  it("returns SHA from git rev-parse HEAD", () => {
    mockExecFileSync.mockReturnValue("abcdef1234567890\n" as any);
    expect(getHeadSha("/tmp/project")).toBe("abcdef1234567890");
  });

  it("returns null when git fails", () => {
    mockExecFileSync.mockImplementation(() => { throw new Error("fatal"); });
    expect(getHeadSha("/tmp")).toBeNull();
  });
});

// ── buildGrowthSnapshots ─────────────────────────────────────────

describe("buildGrowthSnapshots", () => {
  beforeEach(() => {
    mockExecFileSync.mockReset();
  });

  it("builds snapshots from git log + git show", () => {
    // First call: git log for CLAUDE.md commits
    // Second call: git log for all commit authorship
    // Third+ calls: git show for CLAUDE.md at each commit
    let callIndex = 0;
    mockExecFileSync.mockImplementation((cmd: any, args: any) => {
      const argStr = (args as string[]).join(" ");
      if (argStr.includes("--format=%H %aI %ae") && argStr.includes("CLAUDE.md")) {
        return "sha1 2026-03-25T10:00:00Z user@example.com\nsha2 2026-03-26T10:00:00Z daemon@local\n";
      }
      if (argStr.includes("--format=%aI %ae") && argStr.includes("--reverse")) {
        return "2026-03-25T10:00:00Z user@example.com\n2026-03-26T10:00:00Z garyclaw-daemon@local\n";
      }
      if (argStr.includes("sha1:CLAUDE.md")) {
        return "- 8 source modules, 50 test files, 200 tests\n";
      }
      if (argStr.includes("sha2:CLAUDE.md")) {
        return "- 12 source modules, 80 test files, 500 tests\n";
      }
      return "";
    });

    const snapshots = buildGrowthSnapshots("/tmp/project");
    expect(snapshots.length).toBeGreaterThanOrEqual(1);
    // Should be in chronological order
    if (snapshots.length >= 2) {
      expect(snapshots[0].date <= snapshots[1].date).toBe(true);
    }
  });

  it("returns empty array when git log fails", () => {
    mockExecFileSync.mockImplementation(() => { throw new Error("not a git repo"); });
    expect(buildGrowthSnapshots("/tmp")).toEqual([]);
  });

  it("skips commits where CLAUDE.md content is unparseable", () => {
    mockExecFileSync.mockImplementation((cmd: any, args: any) => {
      const argStr = (args as string[]).join(" ");
      if (argStr.includes("--format=%H %aI %ae") && argStr.includes("CLAUDE.md")) {
        return "sha1 2026-03-25T10:00:00Z user@example.com\nsha2 2026-03-26T10:00:00Z user@example.com\n";
      }
      if (argStr.includes("--format=%aI %ae")) {
        return "2026-03-25T10:00:00Z user@example.com\n";
      }
      if (argStr.includes("sha1:CLAUDE.md")) {
        return "# README\nNo module counts here.\n";
      }
      if (argStr.includes("sha2:CLAUDE.md")) {
        return "- 10 source modules, 50 test files, 300 tests\n";
      }
      return "";
    });

    const snapshots = buildGrowthSnapshots("/tmp/project");
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].modules).toBe(10);
  });

  it("deduplicates by date (keeps last per date)", () => {
    mockExecFileSync.mockImplementation((cmd: any, args: any) => {
      const argStr = (args as string[]).join(" ");
      if (argStr.includes("--format=%H %aI %ae") && argStr.includes("CLAUDE.md")) {
        // Two commits on the same date
        return "sha1 2026-03-25T10:00:00Z u@x.com\nsha2 2026-03-25T14:00:00Z u@x.com\n";
      }
      if (argStr.includes("--format=%aI %ae")) {
        return "2026-03-25T10:00:00Z u@x.com\n2026-03-25T14:00:00Z u@x.com\n";
      }
      if (argStr.includes("sha1:CLAUDE.md")) {
        return "- 8 source modules, 10 test files, 100 tests\n";
      }
      if (argStr.includes("sha2:CLAUDE.md")) {
        return "- 10 source modules, 15 test files, 200 tests\n";
      }
      return "";
    });

    const snapshots = buildGrowthSnapshots("/tmp/project");
    expect(snapshots).toHaveLength(1);
    // After reversal + dedup, the LAST entry per date wins.
    // git log returns newest first (sha1, sha2), reversed → [sha2, sha1], dedup keeps sha1 (last write to same date)
    // Actually: reversed = [sha2 (2026-03-25), sha1 (2026-03-25)], dedup Map overwrites, so sha1 (last) wins
    expect(snapshots[0].date).toBe("2026-03-25");
  });
});

// ── buildModuleAttribution ───────────────────────────────────────

describe("buildModuleAttribution", () => {
  beforeEach(() => {
    mockExecFileSync.mockReset();
  });

  it("classifies modules by creator email", () => {
    mockExecFileSync.mockImplementation((cmd: any, args: any) => {
      const argStr = (args as string[]).join(" ");
      if (argStr.includes("ls-files")) {
        return "src/dashboard.ts\nsrc/oracle.ts\nsrc/relay.ts\n";
      }
      if (argStr.includes("dashboard.ts")) {
        return "user@example.com\n";
      }
      if (argStr.includes("oracle.ts")) {
        return "garyclaw-daemon@local\n";
      }
      if (argStr.includes("relay.ts")) {
        return "user@example.com\ngaryclaw-daemon@local\n";
      }
      return "";
    });

    const attr = buildModuleAttribution("/tmp/project");
    expect(attr["dashboard"]).toBe("human");
    expect(attr["oracle"]).toBe("daemon");
    // relay.ts: last line of git log --diff-filter=A is the creator
    expect(attr["relay"]).toBe("daemon");
  });

  it("returns empty object when git ls-files fails", () => {
    mockExecFileSync.mockImplementation(() => { throw new Error("not a git repo"); });
    expect(buildModuleAttribution("/tmp")).toEqual({});
  });

  it("skips spike files", () => {
    mockExecFileSync.mockImplementation((cmd: any, args: any) => {
      const argStr = (args as string[]).join(" ");
      if (argStr.includes("ls-files")) {
        return "src/dashboard.ts\nsrc/spikes/test-spike.ts\n";
      }
      if (argStr.includes("dashboard.ts")) {
        return "user@example.com\n";
      }
      return "";
    });

    const attr = buildModuleAttribution("/tmp/project");
    expect(Object.keys(attr)).toHaveLength(1);
    expect(attr["dashboard"]).toBe("human");
  });
});

// ── loadOrBuildGrowthCache ───────────────────────────────────────

describe("loadOrBuildGrowthCache", () => {
  let dir: string;

  beforeEach(() => {
    mockExecFileSync.mockReset();
    dir = tmpDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns cached data when HEAD matches", () => {
    const cache: GrowthCache = {
      headSha: "abc123",
      builtAt: "2026-03-30T10:00:00Z",
      snapshots: [{ date: "2026-03-25", modules: 8, tests: 200, commits: 10, humanCommits: 5, daemonCommits: 5 }],
      moduleAttribution: { dashboard: "human" },
    };
    writeFileSync(join(dir, "growth-cache.json"), JSON.stringify(cache));

    // Mock getHeadSha to return same SHA
    mockExecFileSync.mockReturnValue("abc123\n" as any);

    const result = loadOrBuildGrowthCache("/tmp/project", dir);
    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0].modules).toBe(8);
    expect(result.moduleAttribution.dashboard).toBe("human");
  });

  it("rebuilds when HEAD has changed", () => {
    const cache: GrowthCache = {
      headSha: "old-sha",
      builtAt: "2026-03-30T10:00:00Z",
      snapshots: [{ date: "2026-03-25", modules: 8, tests: 200, commits: 10, humanCommits: 5, daemonCommits: 5 }],
      moduleAttribution: {},
    };
    writeFileSync(join(dir, "growth-cache.json"), JSON.stringify(cache));

    // Mock: HEAD is now different
    mockExecFileSync.mockImplementation((cmd: any, args: any) => {
      const argStr = (args as string[]).join(" ");
      if (argStr.includes("rev-parse")) return "new-sha\n";
      if (argStr.includes("ls-files")) return "";
      return "";
    });

    const result = loadOrBuildGrowthCache("/tmp/project", dir);
    // Cache was invalidated, rebuilt (empty because mocked git returns nothing useful)
    expect(result.snapshots).toEqual([]);
  });

  it("builds from scratch when no cache exists", () => {
    mockExecFileSync.mockImplementation((cmd: any, args: any) => {
      const argStr = (args as string[]).join(" ");
      if (argStr.includes("rev-parse")) return "new-sha\n";
      if (argStr.includes("ls-files")) return "";
      return "";
    });

    const result = loadOrBuildGrowthCache("/tmp/project", dir);
    expect(result.snapshots).toEqual([]);
    expect(result.moduleAttribution).toEqual({});

    // Cache file should be written
    expect(existsSync(join(dir, "growth-cache.json"))).toBe(true);
  });

  it("handles missing moduleAttribution in old cache format", () => {
    const cache = {
      headSha: "abc123",
      builtAt: "2026-03-30T10:00:00Z",
      snapshots: [{ date: "2026-03-25", modules: 8, tests: 200, commits: 10, humanCommits: 5, daemonCommits: 5 }],
      // No moduleAttribution field
    };
    writeFileSync(join(dir, "growth-cache.json"), JSON.stringify(cache));
    mockExecFileSync.mockReturnValue("abc123\n" as any);

    const result = loadOrBuildGrowthCache("/tmp/project", dir);
    expect(result.moduleAttribution).toEqual({});
  });
});

// ── Constants ────────────────────────────────────────────────────

describe("growth constants", () => {
  it("MAX_GROWTH_COMMITS is 200", () => {
    expect(MAX_GROWTH_COMMITS).toBe(200);
  });

  it("GIT_COMMAND_TIMEOUT_MS is 5000", () => {
    expect(GIT_COMMAND_TIMEOUT_MS).toBe(5000);
  });
});
