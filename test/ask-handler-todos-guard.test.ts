import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isTodosMdWrite, createAskHandler } from "../src/ask-handler.js";

const TEST_DIR = join(tmpdir(), `garyclaw-todos-guard-test-${Date.now()}`);

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("isTodosMdWrite", () => {
  describe("Write tool", () => {
    it("blocks Write to TODOS.md when file exists", () => {
      writeFileSync(join(TEST_DIR, "TODOS.md"), "# TODOs\n");
      const result = isTodosMdWrite("Write", { file_path: "/some/path/TODOS.md" }, TEST_DIR);
      expect(result).not.toBeNull();
      expect(result!.behavior).toBe("deny");
      expect(result!.message).toContain("invented-items.md");
    });

    it("allows Write to TODOS.md when file does not exist (bootstrap cold-start)", () => {
      // TEST_DIR has no TODOS.md
      const result = isTodosMdWrite("Write", { file_path: "/some/path/TODOS.md" }, TEST_DIR);
      expect(result).toBeNull();
    });

    it("blocks Write to TODOS.md when no projectDir (no cold-start check)", () => {
      const result = isTodosMdWrite("Write", { file_path: "/some/path/TODOS.md" });
      expect(result).not.toBeNull();
      expect(result!.behavior).toBe("deny");
    });

    it("allows Write to other files", () => {
      const result = isTodosMdWrite("Write", { file_path: "/some/path/priority.md" }, TEST_DIR);
      expect(result).toBeNull();
    });

    it("allows Write to invented-items.md", () => {
      const result = isTodosMdWrite("Write", { file_path: "/some/.garyclaw/invented-items.md" }, TEST_DIR);
      expect(result).toBeNull();
    });
  });

  describe("Edit tool", () => {
    it("blocks Edit to TODOS.md", () => {
      const result = isTodosMdWrite("Edit", { file_path: "/project/TODOS.md" }, TEST_DIR);
      expect(result).not.toBeNull();
      expect(result!.behavior).toBe("deny");
    });

    it("blocks Edit to TODOS.md even without projectDir", () => {
      // Edit has no cold-start exception
      const result = isTodosMdWrite("Edit", { file_path: "/project/TODOS.md" });
      expect(result).not.toBeNull();
      expect(result!.behavior).toBe("deny");
    });

    it("allows Edit to other files", () => {
      const result = isTodosMdWrite("Edit", { file_path: "/project/README.md" });
      expect(result).toBeNull();
    });
  });

  describe("Bash tool", () => {
    it("blocks redirect write to TODOS.md", () => {
      const result = isTodosMdWrite("Bash", { command: 'echo "item" > TODOS.md' });
      expect(result).not.toBeNull();
      expect(result!.behavior).toBe("deny");
    });

    it("blocks append redirect to TODOS.md", () => {
      const result = isTodosMdWrite("Bash", { command: 'echo "item" >> TODOS.md' });
      expect(result).not.toBeNull();
      expect(result!.behavior).toBe("deny");
    });

    it("blocks tee to TODOS.md", () => {
      const result = isTodosMdWrite("Bash", { command: "cat items.md | tee TODOS.md" });
      expect(result).not.toBeNull();
      expect(result!.behavior).toBe("deny");
    });

    it("blocks cp to TODOS.md", () => {
      const result = isTodosMdWrite("Bash", { command: "cp new-todos.md TODOS.md" });
      expect(result).not.toBeNull();
      expect(result!.behavior).toBe("deny");
    });

    it("blocks mv to TODOS.md", () => {
      const result = isTodosMdWrite("Bash", { command: "mv staged.md TODOS.md" });
      expect(result).not.toBeNull();
      expect(result!.behavior).toBe("deny");
    });

    it("blocks sed -i on TODOS.md", () => {
      const result = isTodosMdWrite("Bash", { command: "sed -i 's/old/new/g' TODOS.md" });
      expect(result).not.toBeNull();
      expect(result!.behavior).toBe("deny");
    });

    it("allows cat (read) of TODOS.md", () => {
      const result = isTodosMdWrite("Bash", { command: "cat TODOS.md" });
      expect(result).toBeNull();
    });

    it("allows grep of TODOS.md", () => {
      const result = isTodosMdWrite("Bash", { command: "grep 'P2' TODOS.md" });
      expect(result).toBeNull();
    });

    it("allows head/tail of TODOS.md", () => {
      const result1 = isTodosMdWrite("Bash", { command: "head -20 TODOS.md" });
      const result2 = isTodosMdWrite("Bash", { command: "tail -10 TODOS.md" });
      expect(result1).toBeNull();
      expect(result2).toBeNull();
    });

    it("allows wc of TODOS.md", () => {
      const result = isTodosMdWrite("Bash", { command: "wc -l TODOS.md" });
      expect(result).toBeNull();
    });

    it("allows Bash commands not involving TODOS.md", () => {
      const result = isTodosMdWrite("Bash", { command: "npm test" });
      expect(result).toBeNull();
    });
  });

  describe("other tools", () => {
    it("allows AskUserQuestion (not a file write)", () => {
      const result = isTodosMdWrite("AskUserQuestion", { questions: [] });
      expect(result).toBeNull();
    });

    it("allows Read tool", () => {
      const result = isTodosMdWrite("Read", { file_path: "TODOS.md" });
      expect(result).toBeNull();
    });
  });
});

describe("canUseTool integration — TODOS.md guard", () => {
  it("denies Write to TODOS.md via full canUseTool callback", async () => {
    writeFileSync(join(TEST_DIR, "TODOS.md"), "# TODOs\n");
    const handler = createAskHandler({
      onAskUser: vi.fn(),
      askTimeoutMs: 5000,
      sessionIndex: 0,
      projectDir: TEST_DIR,
    });

    const result = await handler.canUseTool("Write", {
      file_path: join(TEST_DIR, "TODOS.md"),
    });

    expect(result.behavior).toBe("deny");
    expect(result.message).toContain("invented-items.md");
  });

  it("allows Write to TODOS.md during bootstrap cold-start", async () => {
    // No TODOS.md in TEST_DIR
    const handler = createAskHandler({
      onAskUser: vi.fn(),
      askTimeoutMs: 5000,
      sessionIndex: 0,
      projectDir: TEST_DIR,
    });

    const result = await handler.canUseTool("Write", {
      file_path: join(TEST_DIR, "TODOS.md"),
    });

    expect(result.behavior).toBe("allow");
  });

  it("still allows AskUserQuestion in human mode", async () => {
    const onAskUser = vi.fn().mockResolvedValue("Option A");
    const handler = createAskHandler({
      onAskUser,
      askTimeoutMs: 5000,
      sessionIndex: 0,
      projectDir: TEST_DIR,
    });

    const result = await handler.canUseTool("AskUserQuestion", {
      questions: [
        {
          question: "Pick one?",
          header: "Test",
          options: [
            { label: "Option A", description: "A" },
            { label: "Option B", description: "B" },
          ],
          multiSelect: false,
        },
      ],
    });

    expect(result.behavior).toBe("allow");
    expect(onAskUser).toHaveBeenCalledOnce();
  });
});
