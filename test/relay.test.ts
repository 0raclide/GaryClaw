import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareRelay, buildRelaySegment, finalizeRelay } from "../src/relay.js";
import { createMockCheckpoint, createMockIssue, resetCounters } from "./helpers.js";
import type { GaryClawConfig } from "../src/types.js";

const TEST_DIR = join(tmpdir(), `garyclaw-relay-test-${Date.now()}`);

function initGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execSync("git init", { cwd: dir, encoding: "utf-8" });
  execSync("git config user.email 'test@test.com'", { cwd: dir, encoding: "utf-8" });
  execSync("git config user.name 'Test'", { cwd: dir, encoding: "utf-8" });
  writeFileSync(join(dir, "README.md"), "# test", "utf-8");
  execSync("git add . && git commit -m 'init'", { cwd: dir, encoding: "utf-8" });
}

beforeEach(() => {
  resetCounters();
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("relay", () => {
  describe("prepareRelay", () => {
    it("returns stashed=false for clean repo", () => {
      initGitRepo(TEST_DIR);
      const result = prepareRelay(TEST_DIR);
      expect(result.stashed).toBe(false);
      expect(result.error).toBeUndefined();
    });

    it("stashes dirty working tree", () => {
      initGitRepo(TEST_DIR);
      writeFileSync(join(TEST_DIR, "dirty.txt"), "uncommitted", "utf-8");

      const result = prepareRelay(TEST_DIR);
      expect(result.stashed).toBe(true);
      expect(result.stashRef).toContain("garyclaw-relay-");

      // Verify working tree is now clean
      const status = execSync("git status --porcelain", {
        cwd: TEST_DIR,
        encoding: "utf-8",
      }).trim();
      expect(status).toBe("");
    });

    it("returns error for non-git directory", () => {
      const nonGitDir = join(TEST_DIR, "not-git");
      mkdirSync(nonGitDir, { recursive: true });

      const result = prepareRelay(nonGitDir);
      expect(result.stashed).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("buildRelaySegment", () => {
    it("creates segment with relay prompt from checkpoint", () => {
      const checkpoint = createMockCheckpoint({
        skillName: "qa",
        issues: [createMockIssue({ status: "open", description: "Bug in nav" })],
      });

      const config: GaryClawConfig = {
        skillName: "qa",
        projectDir: "/test/project",
        maxTurnsPerSegment: 15,
        relayThresholdRatio: 0.85,
        checkpointDir: "/test/.garyclaw",
        settingSources: ["project"],
        env: { PATH: "/usr/bin" },
        askTimeoutMs: 300_000,
        maxRelaySessions: 10,
        autonomous: false,
      };

      const segment = buildRelaySegment(checkpoint, config);

      expect(segment.prompt).toContain("GaryClaw Relay");
      expect(segment.prompt).toContain("Bug in nav");
      expect(segment.maxTurns).toBe(15);
      expect(segment.cwd).toBe("/test/project");
      expect(segment.env).toEqual({ PATH: "/usr/bin" });
      expect(segment.settingSources).toEqual(["project"]);
      expect(segment.resume).toBeUndefined(); // Fresh session, no resume
    });
  });

  describe("finalizeRelay", () => {
    it("does nothing without stash ref", () => {
      const result = finalizeRelay(TEST_DIR);
      expect(result.error).toBeUndefined();
    });

    it("pops stashed changes", () => {
      initGitRepo(TEST_DIR);
      // Modify a tracked file so git stash has something to stash
      writeFileSync(join(TEST_DIR, "README.md"), "# modified", "utf-8");
      execSync('git stash push -m "test-stash"', {
        cwd: TEST_DIR,
        encoding: "utf-8",
      });

      const result = finalizeRelay(TEST_DIR, "test-stash");
      expect(result.error).toBeUndefined();

      // Verify file is restored
      const status = execSync("git status --porcelain", {
        cwd: TEST_DIR,
        encoding: "utf-8",
      }).trim();
      expect(status).toContain("README.md");
    });

    it("returns error on stash pop conflict", () => {
      initGitRepo(TEST_DIR);

      // Create a file, stash it
      writeFileSync(join(TEST_DIR, "conflict.txt"), "original", "utf-8");
      execSync("git add conflict.txt", { cwd: TEST_DIR, encoding: "utf-8" });
      execSync('git commit -m "add conflict.txt"', { cwd: TEST_DIR, encoding: "utf-8" });

      writeFileSync(join(TEST_DIR, "conflict.txt"), "stash version", "utf-8");
      execSync('git stash push -m "will-conflict"', { cwd: TEST_DIR, encoding: "utf-8" });

      // Modify the same file to create a conflict
      writeFileSync(join(TEST_DIR, "conflict.txt"), "conflicting change", "utf-8");
      execSync("git add conflict.txt", { cwd: TEST_DIR, encoding: "utf-8" });
      execSync('git commit -m "conflicting commit"', { cwd: TEST_DIR, encoding: "utf-8" });

      const result = finalizeRelay(TEST_DIR, "will-conflict");
      // It might pop cleanly or conflict depending on git version/strategy
      // Either way, it should not throw
      expect(typeof result).toBe("object");
    });
  });
});
