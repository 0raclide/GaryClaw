/**
 * Relay extended tests — executeRelay integration.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeRelay } from "../src/relay.js";
import { createMockCheckpoint, createMockIssue, resetCounters } from "./helpers.js";
import type { GaryClawConfig } from "../src/types.js";

const TEST_DIR = join(tmpdir(), `garyclaw-relay-ext-test-${Date.now()}`);

function initGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execSync("git init", { cwd: dir, encoding: "utf-8" });
  execSync("git config user.email 'test@test.com'", { cwd: dir, encoding: "utf-8" });
  execSync("git config user.name 'Test'", { cwd: dir, encoding: "utf-8" });
  writeFileSync(join(dir, "README.md"), "# test", "utf-8");
  execSync("git add . && git commit -m 'init'", { cwd: dir, encoding: "utf-8" });
}

function makeConfig(projectDir: string): GaryClawConfig {
  return {
    skillName: "qa",
    projectDir,
    maxTurnsPerSegment: 15,
    relayThresholdRatio: 0.85,
    checkpointDir: join(projectDir, ".garyclaw"),
    settingSources: ["project"],
    env: { PATH: "/usr/bin" },
    askTimeoutMs: 300_000,
    maxRelaySessions: 10,
    autonomous: false,
  };
}

beforeEach(() => resetCounters());
afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe("executeRelay", () => {
  it("returns both prepareResult and segmentOptions for clean repo", () => {
    initGitRepo(TEST_DIR);
    const checkpoint = createMockCheckpoint({
      skillName: "qa",
      issues: [createMockIssue({ description: "Nav broken" })],
    });
    const config = makeConfig(TEST_DIR);

    const result = executeRelay(checkpoint, config);

    expect(result.prepareResult.stashed).toBe(false);
    expect(result.prepareResult.error).toBeUndefined();
    expect(result.segmentOptions.prompt).toContain("GaryClaw Relay");
    expect(result.segmentOptions.prompt).toContain("Nav broken");
    expect(result.segmentOptions.maxTurns).toBe(15);
    expect(result.segmentOptions.cwd).toBe(TEST_DIR);
  });

  it("stashes dirty tree and builds relay segment", () => {
    initGitRepo(TEST_DIR);
    writeFileSync(join(TEST_DIR, "dirty.txt"), "uncommitted change", "utf-8");

    const checkpoint = createMockCheckpoint({ skillName: "qa" });
    const config = makeConfig(TEST_DIR);

    const result = executeRelay(checkpoint, config);

    expect(result.prepareResult.stashed).toBe(true);
    expect(result.prepareResult.stashRef).toContain("garyclaw-relay-");
    expect(result.segmentOptions.prompt).toContain("GaryClaw Relay");

    // Clean up: pop stash
    execSync("git stash pop", { cwd: TEST_DIR, encoding: "utf-8" });
  });

  it("passes canUseTool through to segment options", async () => {
    initGitRepo(TEST_DIR);
    const checkpoint = createMockCheckpoint({ skillName: "qa" });
    const config = makeConfig(TEST_DIR);
    const customCanUseTool = async () => ({ behavior: "deny" as const, message: "blocked" });

    const result = executeRelay(checkpoint, config, customCanUseTool);

    const toolResult = await result.segmentOptions.canUseTool!("Bash", {});
    expect(toolResult.behavior).toBe("deny");
    expect(toolResult.message).toBe("blocked");
  });

  it("uses allow-all canUseTool when none provided", async () => {
    initGitRepo(TEST_DIR);
    const checkpoint = createMockCheckpoint({ skillName: "qa" });
    const config = makeConfig(TEST_DIR);

    const result = executeRelay(checkpoint, config);

    const toolResult = await result.segmentOptions.canUseTool!("Bash", {});
    expect(toolResult.behavior).toBe("allow");
  });

  it("handles non-git directory gracefully", () => {
    const nonGitDir = join(TEST_DIR, "not-git");
    mkdirSync(nonGitDir, { recursive: true });

    const checkpoint = createMockCheckpoint({ skillName: "qa" });
    const config = makeConfig(nonGitDir);

    const result = executeRelay(checkpoint, config);

    expect(result.prepareResult.stashed).toBe(false);
    expect(result.prepareResult.error).toBeDefined();
    // Segment should still be built despite stash error
    expect(result.segmentOptions.prompt).toContain("GaryClaw Relay");
  });
});
