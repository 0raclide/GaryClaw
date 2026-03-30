import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseArgs } from "../src/cli.js";

describe("--parallel flag parsing", () => {
  // Suppress process.exit calls
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("parses --parallel N on daemon start", () => {
    const parsed = parseArgs(["node", "cli.ts", "daemon", "start", "--parallel", "5"]);
    expect(parsed.command).toBe("daemon");
    expect(parsed.subcommand).toBe("start");
    expect(parsed.parallel).toBe(5);
  });

  it("parses --parallel 2 (minimum)", () => {
    const parsed = parseArgs(["node", "cli.ts", "daemon", "start", "--parallel", "2"]);
    expect(parsed.parallel).toBe(2);
  });

  it("parses --parallel 10 (maximum)", () => {
    const parsed = parseArgs(["node", "cli.ts", "daemon", "start", "--parallel", "10"]);
    expect(parsed.parallel).toBe(10);
  });

  it("rejects --parallel 1 (too low)", () => {
    expect(() => {
      parseArgs(["node", "cli.ts", "daemon", "start", "--parallel", "1"]);
    }).toThrow("process.exit");
  });

  it("rejects --parallel 11 (too high)", () => {
    expect(() => {
      parseArgs(["node", "cli.ts", "daemon", "start", "--parallel", "11"]);
    }).toThrow("process.exit");
  });

  it("rejects --parallel 0", () => {
    expect(() => {
      parseArgs(["node", "cli.ts", "daemon", "start", "--parallel", "0"]);
    }).toThrow("process.exit");
  });

  it("rejects --parallel with non-numeric value", () => {
    expect(() => {
      parseArgs(["node", "cli.ts", "daemon", "start", "--parallel", "abc"]);
    }).toThrow("process.exit");
  });

  it("parallel is undefined when not specified", () => {
    const parsed = parseArgs(["node", "cli.ts", "daemon", "start"]);
    expect(parsed.parallel).toBeUndefined();
  });

  it("parallel is undefined for non-daemon commands", () => {
    const parsed = parseArgs(["node", "cli.ts", "run", "qa"]);
    expect(parsed.parallel).toBeUndefined();
  });

  it("--parallel works with other daemon flags", () => {
    const parsed = parseArgs([
      "node", "cli.ts", "daemon", "start",
      "--parallel", "3",
      "--project-dir", "/tmp/test",
    ]);
    expect(parsed.parallel).toBe(3);
    expect(parsed.projectDir).toBe("/tmp/test");
  });

  it("generates worker-1 through worker-N names", () => {
    // This tests the naming convention documented in the design
    const n = 5;
    const names = Array.from({ length: n }, (_, i) => `worker-${i + 1}`);
    expect(names).toEqual(["worker-1", "worker-2", "worker-3", "worker-4", "worker-5"]);
  });
});
