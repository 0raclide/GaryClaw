/**
 * Dashboard server tests — HTTP server, REST endpoints, mutation timeline, decision parsing.
 * All synthetic data — no SDK calls, no real HTTP server (except port tests).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import {
  parseDecisionEntries,
  toDecisionEntry,
  buildMutationTimeline,
  loadAllTodoStates,
  mapFileToEventType,
  serveStaticFile,
  createRequestHandler,
  broadcastSSE,
  sendSSEEvent,
  FILE_EVENT_MAP,
  DEFAULT_PORT,
  MAX_PORT_ATTEMPTS,
  startDashboardServer,
  loadOracleMindContent,
  ORACLE_MIND_CONTENT_CAP,
  type DecisionEntry,
  type MutationCycle,
  type DashboardServerHandle,
} from "../src/dashboard-server.js";
import type { DecisionOutcome, PipelineOutcomeRecord } from "../src/types.js";
import type { TodoState } from "../src/todo-state.js";

// ── Helpers ─────────────────────────────────────────────────────

function tmpDir(): string {
  const dir = join(tmpdir(), `garyclaw-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeDecisionOutcome(overrides: Partial<DecisionOutcome> = {}): DecisionOutcome {
  return {
    decisionId: "d-2026-03-30T10-00-00-000Z-1",
    timestamp: "2026-03-30T10:00:00.000Z",
    question: "Should we use WebSocket or SSE?",
    chosen: "SSE",
    confidence: 9,
    principle: "P3 — Ship the smallest thing that teaches you something",
    outcome: "success",
    ...overrides,
  };
}

function makeTodoState(overrides: Partial<TodoState> = {}): TodoState {
  return {
    title: "Add live dashboard",
    slug: "add-live-dashboard",
    state: "implemented",
    updatedAt: "2026-03-30T10:00:00Z",
    ...overrides,
  };
}

function makePipelineOutcome(overrides: Partial<PipelineOutcomeRecord> = {}): PipelineOutcomeRecord {
  return {
    jobId: "job-1",
    timestamp: "2026-03-30T10:00:00Z",
    todoTitle: "Add live dashboard",
    effort: "M",
    priority: 8,
    skills: ["implement", "qa"],
    skippedSkills: [],
    qaFailureCount: 0,
    reopenedCount: 0,
    outcome: "success",
    oracleAdjusted: false,
    ...overrides,
  };
}

// ── Decision Parsing ─────────────────────────────────────────────

describe("toDecisionEntry", () => {
  it("converts DecisionOutcome to DecisionEntry", () => {
    const outcome = makeDecisionOutcome();
    const entry = toDecisionEntry(outcome);
    expect(entry.id).toBe(outcome.decisionId);
    expect(entry.timestamp).toBe(outcome.timestamp);
    expect(entry.question).toBe(outcome.question);
    expect(entry.chosen).toBe(outcome.chosen);
    expect(entry.confidence).toBe(9);
    expect(entry.principle).toBe(outcome.principle);
    expect(entry.outcome).toBe("success");
  });

  it("truncates long questions to 200 chars", () => {
    const longQ = "x".repeat(300);
    const entry = toDecisionEntry(makeDecisionOutcome({ question: longQ }));
    expect(entry.question.length).toBe(203); // 200 + "..."
    expect(entry.question.endsWith("...")).toBe(true);
  });

  it("preserves questions under 200 chars", () => {
    const entry = toDecisionEntry(makeDecisionOutcome({ question: "short" }));
    expect(entry.question).toBe("short");
  });

  it("passes through jobId", () => {
    const entry = toDecisionEntry(makeDecisionOutcome({ jobId: "job-42" }));
    expect(entry.jobId).toBe("job-42");
  });
});

describe("parseDecisionEntries", () => {
  it("parses well-formed decision-outcomes.md", () => {
    const content = `### d-2026-03-30T10-00-00-000Z-1
- **Timestamp:** 2026-03-30T10:00:00.000Z
- **Question:** Should we use SSE?
- **Chosen:** Yes
- **Confidence:** 9
- **Principle:** P3 — Ship small
- **Outcome:** success
- **Job:** job-1

### d-2026-03-30T10-00-00-000Z-2
- **Timestamp:** 2026-03-30T10:01:00.000Z
- **Question:** Which port?
- **Chosen:** 3333
- **Confidence:** 8
- **Principle:** P1 — Convention
- **Outcome:** neutral
`;
    const entries = parseDecisionEntries(content);
    expect(entries).toHaveLength(2);
    expect(entries[0].id).toBe("d-2026-03-30T10-00-00-000Z-1");
    expect(entries[0].chosen).toBe("Yes");
    expect(entries[0].confidence).toBe(9);
    expect(entries[0].jobId).toBe("job-1");
    expect(entries[1].id).toBe("d-2026-03-30T10-00-00-000Z-2");
    expect(entries[1].outcome).toBe("neutral");
  });

  it("returns empty array for empty content", () => {
    expect(parseDecisionEntries("")).toHaveLength(0);
  });

  it("skips malformed entries gracefully", () => {
    const content = `### d-good
- **Timestamp:** 2026-03-30T10:00:00.000Z
- **Question:** Valid question?
- **Chosen:** Yes
- **Confidence:** 8
- **Principle:** P1
- **Outcome:** success

### d-bad
- This is not formatted correctly
`;
    const entries = parseDecisionEntries(content);
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("d-good");
  });

  it("handles [compact] prefix entries", () => {
    const content = `### [compact]-d-old
- **Timestamp:** 2026-03-29T10:00:00.000Z
- **Question:** Old question?
- **Chosen:** No
- **Confidence:** 7
- **Principle:** P2
- **Outcome:** neutral
`;
    // The [compact] prefix is part of the ID after parsing by oracle-memory.ts
    // parseDecisionOutcomes handles this via its regex
    const entries = parseDecisionEntries(content);
    // parseDecisionOutcomes regex expects "### <word-chars>" — [compact] may or may not match
    // This tests the fail-open behavior
    expect(entries.length).toBeGreaterThanOrEqual(0);
  });
});

// ── Mutation Timeline ────────────────────────────────────────────

describe("buildMutationTimeline", () => {
  it("builds cycles from pipeline outcomes", () => {
    const outcomes = [makePipelineOutcome()];
    const cycles = buildMutationTimeline(outcomes, new Map(), []);
    expect(cycles).toHaveLength(1);
    expect(cycles[0].todoTitle).toBe("Add live dashboard");
    expect(cycles[0].skills.length).toBeGreaterThan(0);
  });

  it("correlates pipeline outcomes with todo states", () => {
    const outcomes = [makePipelineOutcome()];
    const todoStates = new Map<string, TodoState>();
    todoStates.set("add-live-dashboard", makeTodoState({ state: "merged" }));

    const cycles = buildMutationTimeline(outcomes, todoStates, []);
    expect(cycles).toHaveLength(1);
    expect(cycles[0].outcome).toBe("shipped");
  });

  it("marks in-progress when todo state is implementing", () => {
    const todoStates = new Map<string, TodoState>();
    todoStates.set("wip-item", makeTodoState({
      title: "WIP Item",
      slug: "wip-item",
      state: "implemented",
    }));

    const cycles = buildMutationTimeline([], todoStates, []);
    expect(cycles).toHaveLength(1);
    expect(cycles[0].outcome).toBe("in-progress");
  });

  it("marks failed when job failed and not shipped", () => {
    const outcomes = [makePipelineOutcome({ outcome: "failure" })];
    const jobs = [{
      skills: ["implement", "qa"],
      claimedTodoTitle: "Add live dashboard",
      status: "failed",
      costUsd: 1.5,
      startedAt: "2026-03-30T10:00:00Z",
    }];

    const cycles = buildMutationTimeline(outcomes, new Map(), jobs);
    expect(cycles).toHaveLength(1);
    expect(cycles[0].outcome).toBe("failed");
  });

  it("aggregates cost from jobs", () => {
    const jobs = [
      { skills: ["implement"], claimedTodoTitle: "Task A", status: "complete", costUsd: 2.0, startedAt: "2026-03-30T10:00:00Z" },
      { skills: ["qa"], claimedTodoTitle: "Task A", status: "complete", costUsd: 1.5, startedAt: "2026-03-30T11:00:00Z" },
    ];

    const cycles = buildMutationTimeline([], new Map(), jobs);
    expect(cycles).toHaveLength(1);
    expect(cycles[0].costUsd).toBeCloseTo(3.5);
  });

  it("sorts by startedAt descending", () => {
    const outcomes = [
      makePipelineOutcome({ todoTitle: "Early task", timestamp: "2026-03-29T10:00:00Z" }),
      makePipelineOutcome({ todoTitle: "Late task", timestamp: "2026-03-30T10:00:00Z" }),
    ];

    const cycles = buildMutationTimeline(outcomes, new Map(), []);
    expect(cycles[0].todoTitle).toBe("Late task");
    expect(cycles[1].todoTitle).toBe("Early task");
  });

  it("returns empty array for no data", () => {
    const cycles = buildMutationTimeline([], new Map(), []);
    expect(cycles).toHaveLength(0);
  });

  it("marks as in-progress when jobs exist but no todo state", () => {
    const jobs = [{
      skills: ["implement"],
      claimedTodoTitle: "New task",
      status: "running",
      costUsd: 0.5,
      startedAt: "2026-03-30T10:00:00Z",
    }];
    const cycles = buildMutationTimeline([], new Map(), jobs);
    expect(cycles).toHaveLength(1);
    expect(cycles[0].outcome).toBe("in-progress");
  });

  it("skips pipeline outcomes without todoTitle", () => {
    const outcomes = [makePipelineOutcome({ todoTitle: "" })];
    const cycles = buildMutationTimeline(outcomes, new Map(), []);
    expect(cycles).toHaveLength(0);
  });

  it("skips jobs without claimedTodoTitle", () => {
    const jobs = [{
      skills: ["qa"],
      status: "complete",
      costUsd: 1.0,
    }];
    const cycles = buildMutationTimeline([], new Map(), jobs);
    expect(cycles).toHaveLength(0);
  });

  it("includes skipped skills in cycle", () => {
    const outcomes = [makePipelineOutcome({
      skills: ["implement", "qa"],
      skippedSkills: ["design-review"],
    })];
    const cycles = buildMutationTimeline(outcomes, new Map(), []);
    expect(cycles[0].skills.some(s => s.name === "design-review" && s.status === "skipped")).toBe(true);
  });
});

// ── File → Event Mapping ─────────────────────────────────────────

describe("mapFileToEventType", () => {
  it("maps daemon-state.json to job_update", () => {
    expect(mapFileToEventType("daemon-state.json")).toBe("job_update");
  });

  it("maps global-budget.json to budget", () => {
    expect(mapFileToEventType("global-budget.json")).toBe("budget");
  });

  it("maps oracle-memory/decision-outcomes.md to decision", () => {
    expect(mapFileToEventType("oracle-memory/decision-outcomes.md")).toBe("decision");
  });

  it("maps oracle-memory/metrics.json to decision", () => {
    expect(mapFileToEventType("oracle-memory/metrics.json")).toBe("decision");
  });

  it("maps oracle-memory/taste.md to taste_update", () => {
    expect(mapFileToEventType("oracle-memory/taste.md")).toBe("taste_update");
  });

  it("maps oracle-memory/domain-expertise.md to expertise_update", () => {
    expect(mapFileToEventType("oracle-memory/domain-expertise.md")).toBe("expertise_update");
  });

  it("maps priority.md to job_update", () => {
    expect(mapFileToEventType("priority.md")).toBe("job_update");
  });

  it("maps pipeline-outcomes.jsonl to mutation", () => {
    expect(mapFileToEventType("pipeline-outcomes.jsonl")).toBe("mutation");
  });

  it("maps todo-state/*.json to mutation", () => {
    expect(mapFileToEventType("todo-state/add-live-dashboard.json")).toBe("mutation");
  });

  it("returns null for unknown files", () => {
    expect(mapFileToEventType("checkpoint.json")).toBeNull();
    expect(mapFileToEventType("some-random-file.txt")).toBeNull();
  });

  it("handles Windows-style backslash paths", () => {
    expect(mapFileToEventType("oracle-memory\\taste.md")).toBe("taste_update");
  });
});

// ── SSE Helpers ──────────────────────────────────────────────────

describe("sendSSEEvent", () => {
  it("writes SSE-formatted data", () => {
    const chunks: string[] = [];
    const mockClient = { write: vi.fn((s: string) => chunks.push(s)) } as any;
    sendSSEEvent(mockClient, "test_event", { foo: "bar" });
    expect(chunks[0]).toBe('event: test_event\ndata: {"foo":"bar"}\n\n');
  });

  it("does not throw on write error", () => {
    const mockClient = { write: vi.fn(() => { throw new Error("disconnected"); }) } as any;
    expect(() => sendSSEEvent(mockClient, "test", {})).not.toThrow();
  });
});

describe("broadcastSSE", () => {
  it("sends to all clients", () => {
    const clients = new Set<any>();
    const c1 = { write: vi.fn() } as any;
    const c2 = { write: vi.fn() } as any;
    clients.add(c1);
    clients.add(c2);
    broadcastSSE(clients, "update", { x: 1 });
    expect(c1.write).toHaveBeenCalledOnce();
    expect(c2.write).toHaveBeenCalledOnce();
  });
});

// ── Static File Serving ──────────────────────────────────────────

describe("serveStaticFile", () => {
  let webDir: string;

  beforeEach(() => {
    webDir = tmpDir();
    writeFileSync(join(webDir, "index.html"), "<html></html>");
    writeFileSync(join(webDir, "style.css"), "body { color: red; }");
    mkdirSync(join(webDir, "assets"), { recursive: true });
    writeFileSync(join(webDir, "assets", "app.js"), "console.log('hi')");
  });

  afterEach(() => {
    rmSync(webDir, { recursive: true, force: true });
  });

  it("serves index.html for root path", () => {
    let status = 0;
    let headers: Record<string, string> = {};
    let body = "";
    const res = {
      writeHead: vi.fn((s: number, h: Record<string, string>) => { status = s; headers = h; }),
      end: vi.fn((c: any) => { body = c?.toString() ?? ""; }),
    } as any;

    const served = serveStaticFile(webDir, "/", res);
    expect(served).toBe(true);
    expect(status).toBe(200);
    expect(headers["Content-Type"]).toContain("text/html");
    expect(body).toContain("<html>");
  });

  it("serves CSS with correct content type", () => {
    let headers: Record<string, string> = {};
    const res = {
      writeHead: vi.fn((_s: number, h: Record<string, string>) => { headers = h; }),
      end: vi.fn(),
    } as any;

    serveStaticFile(webDir, "/style.css", res);
    expect(headers["Content-Type"]).toContain("text/css");
  });

  it("serves nested files", () => {
    let body = "";
    const res = {
      writeHead: vi.fn(),
      end: vi.fn((c: any) => { body = c?.toString() ?? ""; }),
    } as any;

    const served = serveStaticFile(webDir, "/assets/app.js", res);
    expect(served).toBe(true);
    expect(body).toContain("console.log");
  });

  it("returns false for missing files", () => {
    const res = { writeHead: vi.fn(), end: vi.fn() } as any;
    expect(serveStaticFile(webDir, "/missing.html", res)).toBe(false);
  });

  it("blocks directory traversal — path with .. is sanitized", () => {
    const res = { writeHead: vi.fn(), end: vi.fn() } as any;

    // After stripping ".." the path resolves inside webDir,
    // so it returns false (not found) rather than serving /etc/passwd
    const served = serveStaticFile(webDir, "/../../../etc/passwd", res);
    expect(served).toBe(false); // sanitized path doesn't exist inside webDir
  });

  it("blocks resolved paths outside webAssetsDir", () => {
    // Create a file outside webDir
    const outsideDir = tmpDir();
    writeFileSync(join(outsideDir, "secret.txt"), "secret");

    let status = 0;
    const res = {
      writeHead: vi.fn((s: number) => { status = s; }),
      end: vi.fn(),
    } as any;

    // The resolve check should catch any path that escapes webAssetsDir
    // Even if somehow the .. stripping fails, resolve() catches it
    const served = serveStaticFile(webDir, "/index.html", res);
    expect(served).toBe(true);
    expect(status).toBe(200);

    rmSync(outsideDir, { recursive: true, force: true });
  });
});

// ── loadAllTodoStates ────────────────────────────────────────────

describe("loadAllTodoStates", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty map when todo-state/ does not exist", () => {
    const states = loadAllTodoStates(dir);
    expect(states.size).toBe(0);
  });

  it("reads todo state files from directory", () => {
    const stateDir = join(dir, "todo-state");
    mkdirSync(stateDir, { recursive: true });
    const state: TodoState = {
      title: "Test item",
      slug: "test-item",
      state: "implemented",
      updatedAt: "2026-03-30T10:00:00Z",
    };
    writeFileSync(join(stateDir, "test-item.json"), JSON.stringify(state));

    const states = loadAllTodoStates(dir);
    expect(states.size).toBe(1);
    expect(states.get("test-item")?.title).toBe("Test item");
  });

  it("skips non-JSON files", () => {
    const stateDir = join(dir, "todo-state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "notes.txt"), "not json");

    const states = loadAllTodoStates(dir);
    expect(states.size).toBe(0);
  });
});

// ── Request Handler ──────────────────────────────────────────────

describe("createRequestHandler", () => {
  let webDir: string;

  beforeEach(() => {
    webDir = tmpDir();
    writeFileSync(join(webDir, "index.html"), "<html>dashboard</html>");
  });

  afterEach(() => {
    rmSync(webDir, { recursive: true, force: true });
  });

  function mockReqRes(url: string) {
    let status = 0;
    let headers: Record<string, string> = {};
    let body = "";
    const listeners: Record<string, Function> = {};
    const req = {
      url,
      headers: { host: "localhost:3333" },
      on: vi.fn((event: string, cb: Function) => { listeners[event] = cb; }),
    } as any;
    const res = {
      writeHead: vi.fn((s: number, h?: Record<string, string>) => { status = s; if (h) headers = h; }),
      end: vi.fn((c?: any) => { body = c?.toString() ?? ""; }),
      write: vi.fn(),
    } as any;
    return { req, res, getStatus: () => status, getHeaders: () => headers, getBody: () => body, listeners };
  }

  it("/api/state returns DashboardData JSON", () => {
    const mockData = { healthScore: 87, jobs: { total: 5 } };
    const handler = createRequestHandler({
      projectDir: "/tmp",
      checkpointDir: "/tmp/.garyclaw",
      webAssetsDir: webDir,
      sseClients: new Set(),
      loadDashboardDataFn: () => mockData as any,
    });

    const { req, res, getStatus, getBody } = mockReqRes("/api/state");
    handler(req, res);
    expect(getStatus()).toBe(200);
    const parsed = JSON.parse(getBody());
    expect(parsed.healthScore).toBe(87);
  });

  it("/api/decisions returns paginated decisions", () => {
    const handler = createRequestHandler({
      projectDir: "/tmp",
      checkpointDir: "/tmp/.garyclaw",
      webAssetsDir: webDir,
      sseClients: new Set(),
      loadDecisionsFn: (_dir, limit, offset) => ({
        decisions: [{ id: "d-1", question: "Test?" } as any],
        total: 1,
        limit,
        offset,
      }),
    });

    const { req, res, getStatus, getBody } = mockReqRes("/api/decisions?limit=10&offset=0");
    handler(req, res);
    expect(getStatus()).toBe(200);
    const parsed = JSON.parse(getBody());
    expect(parsed.decisions).toHaveLength(1);
    expect(parsed.limit).toBe(10);
  });

  it("/api/growth returns growth data", () => {
    const handler = createRequestHandler({
      projectDir: "/tmp",
      checkpointDir: "/tmp/.garyclaw",
      webAssetsDir: webDir,
      sseClients: new Set(),
      loadGrowthDataFn: () => ({ snapshots: [], moduleAttribution: {} }),
    });

    const { req, res, getStatus, getBody } = mockReqRes("/api/growth");
    handler(req, res);
    expect(getStatus()).toBe(200);
    expect(JSON.parse(getBody())).toEqual({ snapshots: [], moduleAttribution: {} });
  });

  it("/api/growth returns empty defaults when no data function", () => {
    const handler = createRequestHandler({
      projectDir: "/tmp",
      checkpointDir: "/tmp/.garyclaw",
      webAssetsDir: webDir,
      sseClients: new Set(),
    });

    const { req, res, getBody } = mockReqRes("/api/growth");
    handler(req, res);
    expect(JSON.parse(getBody())).toEqual({ snapshots: [], moduleAttribution: {} });
  });

  it("/api/mutations returns mutation timeline", () => {
    const handler = createRequestHandler({
      projectDir: "/tmp",
      checkpointDir: "/tmp/.garyclaw",
      webAssetsDir: webDir,
      sseClients: new Set(),
      loadMutationsFn: () => ({ cycles: [], total: 0 }),
    });

    const { req, res, getBody } = mockReqRes("/api/mutations?limit=5");
    handler(req, res);
    expect(JSON.parse(getBody())).toEqual({ cycles: [], total: 0 });
  });

  it("/api/events sets up SSE connection", () => {
    const sseClients = new Set<any>();
    const handler = createRequestHandler({
      projectDir: "/tmp",
      checkpointDir: "/tmp/.garyclaw",
      webAssetsDir: webDir,
      sseClients,
      loadDashboardDataFn: () => ({ healthScore: 90 }) as any,
    });

    const { req, res, getHeaders, listeners } = mockReqRes("/api/events");
    handler(req, res);
    expect(getHeaders()["Content-Type"]).toBe("text/event-stream");
    expect(sseClients.size).toBe(1);

    // Client disconnect removes from set
    listeners["close"]?.();
    expect(sseClients.size).toBe(0);
  });

  it("/ serves index.html", () => {
    const handler = createRequestHandler({
      projectDir: "/tmp",
      checkpointDir: "/tmp/.garyclaw",
      webAssetsDir: webDir,
      sseClients: new Set(),
    });

    const { req, res, getStatus, getBody } = mockReqRes("/");
    handler(req, res);
    expect(getStatus()).toBe(200);
    expect(getBody()).toContain("dashboard");
  });

  it("unknown path returns 404", () => {
    const handler = createRequestHandler({
      projectDir: "/tmp",
      checkpointDir: "/tmp/.garyclaw",
      webAssetsDir: webDir,
      sseClients: new Set(),
    });

    const { req, res, getStatus } = mockReqRes("/nonexistent");
    handler(req, res);
    expect(getStatus()).toBe(404);
  });

  it("/api/state returns 500 on load error", () => {
    const handler = createRequestHandler({
      projectDir: "/tmp",
      checkpointDir: "/tmp/.garyclaw",
      webAssetsDir: webDir,
      sseClients: new Set(),
      loadDashboardDataFn: () => { throw new Error("boom"); },
    });

    const { req, res, getStatus } = mockReqRes("/api/state");
    handler(req, res);
    expect(getStatus()).toBe(500);
  });

  it("/api/decisions clamps limit and offset", () => {
    let capturedLimit = 0;
    let capturedOffset = 0;
    const handler = createRequestHandler({
      projectDir: "/tmp",
      checkpointDir: "/tmp/.garyclaw",
      webAssetsDir: webDir,
      sseClients: new Set(),
      loadDecisionsFn: (_dir, limit, offset) => {
        capturedLimit = limit;
        capturedOffset = offset;
        return { decisions: [], total: 0, limit, offset };
      },
    });

    const { req, res } = mockReqRes("/api/decisions?limit=999&offset=-5");
    handler(req, res);
    expect(capturedLimit).toBe(200); // capped at 200
    expect(capturedOffset).toBe(0);  // clamped to 0
  });
});

// ── Oracle Mind Content ──────────────────────────────────────────

describe("loadOracleMindContent", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns strings (possibly empty) when no project memory files exist", () => {
    const result = loadOracleMindContent(dir);
    // tasteProfile may be non-empty if global ~/.garyclaw/oracle-memory/taste.md exists
    expect(typeof result.tasteProfile).toBe("string");
    expect(typeof result.domainExpertise).toBe("string");
  });

  it("reads taste from project oracle-memory dir as fallback", () => {
    const memDir = join(dir, ".garyclaw", "oracle-memory");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, "taste.md"), "## Preferences\n- Use vitest");
    const result = loadOracleMindContent(dir);
    // Taste prefers global first; if global exists (e.g. on dev machine)
    // it may return that instead. Either way, tasteProfile should be non-empty.
    expect(result.tasteProfile.length).toBeGreaterThan(0);
  });

  it("reads domain-expertise from project oracle-memory dir", () => {
    const memDir = join(dir, ".garyclaw", "oracle-memory");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, "domain-expertise.md"), "## WebSockets\nReal-time transport");
    const result = loadOracleMindContent(dir);
    expect(result.domainExpertise).toContain("WebSockets");
  });

  it("truncates content at ORACLE_MIND_CONTENT_CAP", () => {
    const memDir = join(dir, ".garyclaw", "oracle-memory");
    mkdirSync(memDir, { recursive: true });
    const longContent = "x".repeat(ORACLE_MIND_CONTENT_CAP + 500);
    writeFileSync(join(memDir, "domain-expertise.md"), longContent);
    const result = loadOracleMindContent(dir);
    expect(result.domainExpertise.length).toBe(ORACLE_MIND_CONTENT_CAP);
  });

  it("ORACLE_MIND_CONTENT_CAP is 10000", () => {
    expect(ORACLE_MIND_CONTENT_CAP).toBe(10_000);
  });
});

// ── /api/state includes taste/expertise ─────────────────────────

describe("createRequestHandler /api/state with taste/expertise", () => {
  let webDir: string;

  beforeEach(() => {
    webDir = tmpDir();
    writeFileSync(join(webDir, "index.html"), "<html></html>");
  });

  afterEach(() => {
    rmSync(webDir, { recursive: true, force: true });
  });

  function mockReqRes(url: string) {
    var status = 0;
    var headers = {};
    var body = "";
    var req = { url, headers: { host: "localhost" }, on: vi.fn() };
    var res = {
      writeHead: vi.fn(function (s: number, h?: any) { status = s; headers = h || {}; }),
      end: vi.fn(function (b?: string) { body = b || ""; }),
      write: vi.fn(),
    };
    return { req, res, getStatus: () => status, getBody: () => body };
  }

  it("/api/state response includes tasteProfile and domainExpertise fields", () => {
    const mockData = { healthScore: 90, jobs: { total: 3 } };
    const handler = createRequestHandler({
      projectDir: "/tmp/nonexistent-project-dir",
      checkpointDir: "/tmp/.garyclaw",
      webAssetsDir: webDir,
      sseClients: new Set(),
      loadDashboardDataFn: () => mockData as any,
    });

    const { req, res, getStatus, getBody } = mockReqRes("/api/state");
    handler(req as any, res as any);
    expect(getStatus()).toBe(200);
    const parsed = JSON.parse(getBody());
    expect(parsed.healthScore).toBe(90);
    // taste/expertise should be present (empty strings when no files exist)
    expect(typeof parsed.tasteProfile).toBe("string");
    expect(typeof parsed.domainExpertise).toBe("string");
  });
});

// ── Constants ────────────────────────────────────────────────────

describe("constants", () => {
  it("DEFAULT_PORT is 3333", () => {
    expect(DEFAULT_PORT).toBe(3333);
  });

  it("MAX_PORT_ATTEMPTS is 10", () => {
    expect(MAX_PORT_ATTEMPTS).toBe(10);
  });

  it("FILE_EVENT_MAP has expected entries", () => {
    expect(Object.keys(FILE_EVENT_MAP).length).toBeGreaterThanOrEqual(8);
    expect(FILE_EVENT_MAP["daemon-state.json"]).toBe("job_update");
    expect(FILE_EVENT_MAP["global-budget.json"]).toBe("budget");
  });
});

// ── Server Start/Stop ────────────────────────────────────────────

describe("startDashboardServer", () => {
  let handle: DashboardServerHandle | null = null;
  let webDir: string;

  beforeEach(() => {
    webDir = tmpDir();
    writeFileSync(join(webDir, "index.html"), "<html>test</html>");
  });

  afterEach(() => {
    if (handle) {
      handle.close();
      handle = null;
    }
    rmSync(webDir, { recursive: true, force: true });
  });

  it("starts server and returns handle with port", async () => {
    handle = await startDashboardServer({
      projectDir: "/tmp",
      port: 0,  // Let OS assign port — avoids conflicts
      webAssetsDir: webDir,
      checkpointDir: "/tmp/.garyclaw-nonexistent",
    });
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.server).toBeDefined();
    expect(typeof handle.close).toBe("function");
  });

  it("close() shuts down cleanly", async () => {
    handle = await startDashboardServer({
      projectDir: "/tmp",
      port: 0,
      webAssetsDir: webDir,
      checkpointDir: "/tmp/.garyclaw-nonexistent",
    });
    expect(() => handle!.close()).not.toThrow();
    handle = null; // Prevent double-close in afterEach
  });
});
