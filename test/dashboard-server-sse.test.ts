/**
 * Dashboard server SSE tests — event dispatch, debounce, file change mapping, client tracking.
 * All synthetic data — no real HTTP server or filesystem watching.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import {
  sendSSEEvent,
  broadcastSSE,
  mapFileToEventType,
  createFileWatcher,
  createRequestHandler,
  type SSEClient,
  type FileWatcherHandle,
} from "../src/dashboard-server.js";

// ── Helpers ─────────────────────────────────────────────────────

function tmpDir(): string {
  const dir = join(tmpdir(), `garyclaw-sse-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function mockSSEClient(): SSEClient & { chunks: string[]; closed: boolean } {
  const chunks: string[] = [];
  return {
    chunks,
    closed: false,
    write: vi.fn((data: string) => { chunks.push(data); return true; }),
    end: vi.fn(function(this: any) { this.closed = true; }),
    writeHead: vi.fn(),
    on: vi.fn(),
  } as any;
}

// ── SSE Event Format ─────────────────────────────────────────────

describe("SSE event format", () => {
  it("sends event with correct SSE format", () => {
    const client = mockSSEClient();
    sendSSEEvent(client, "job_update", { status: "running" });
    expect(client.chunks[0]).toBe('event: job_update\ndata: {"status":"running"}\n\n');
  });

  it("serializes complex nested data", () => {
    const client = mockSSEClient();
    sendSSEEvent(client, "init", { health: 87, jobs: { total: 5, failed: 1 } });
    const parsed = JSON.parse(client.chunks[0].split("data: ")[1].split("\n")[0]);
    expect(parsed.health).toBe(87);
    expect(parsed.jobs.total).toBe(5);
  });

  it("handles null data gracefully", () => {
    const client = mockSSEClient();
    sendSSEEvent(client, "test", null);
    expect(client.chunks[0]).toContain("data: null");
  });
});

// ── Broadcast ────────────────────────────────────────────────────

describe("broadcastSSE", () => {
  it("sends to all connected clients", () => {
    const clients = new Set<SSEClient>();
    const c1 = mockSSEClient();
    const c2 = mockSSEClient();
    const c3 = mockSSEClient();
    clients.add(c1);
    clients.add(c2);
    clients.add(c3);

    broadcastSSE(clients, "budget", { spent: 26.58 });
    expect(c1.chunks).toHaveLength(1);
    expect(c2.chunks).toHaveLength(1);
    expect(c3.chunks).toHaveLength(1);
    // All clients get identical data
    expect(c1.chunks[0]).toBe(c2.chunks[0]);
    expect(c2.chunks[0]).toBe(c3.chunks[0]);
  });

  it("handles empty client set", () => {
    const clients = new Set<SSEClient>();
    expect(() => broadcastSSE(clients, "test", {})).not.toThrow();
  });

  it("continues sending to other clients when one throws", () => {
    const clients = new Set<SSEClient>();
    const badClient = { write: vi.fn(() => { throw new Error("disconnected"); }) } as any;
    const goodClient = mockSSEClient();
    clients.add(badClient);
    clients.add(goodClient);

    broadcastSSE(clients, "update", { x: 1 });
    // Good client still received the event
    expect(goodClient.chunks).toHaveLength(1);
  });
});

// ── SSE Connection Lifecycle ─────────────────────────────────────

describe("SSE connection via /api/events", () => {
  it("sets correct SSE headers", () => {
    const sseClients = new Set<SSEClient>();
    const handler = createRequestHandler({
      projectDir: "/tmp",
      checkpointDir: "/tmp/.garyclaw",
      webAssetsDir: "/tmp",
      sseClients,
      loadDashboardDataFn: () => ({ healthScore: 90 }) as any,
    });

    let headers: Record<string, string> = {};
    const res = {
      writeHead: vi.fn((_s: number, h: Record<string, string>) => { headers = h; }),
      write: vi.fn(),
      end: vi.fn(),
    } as any;
    const req = {
      url: "/api/events",
      headers: { host: "localhost:3333" },
      on: vi.fn(),
    } as any;

    handler(req, res);

    expect(headers["Content-Type"]).toBe("text/event-stream");
    expect(headers["Cache-Control"]).toBe("no-cache");
    expect(headers["Connection"]).toBe("keep-alive");
  });

  it("sends init event on connect", () => {
    const sseClients = new Set<SSEClient>();
    const handler = createRequestHandler({
      projectDir: "/tmp",
      checkpointDir: "/tmp/.garyclaw",
      webAssetsDir: "/tmp",
      sseClients,
      loadDashboardDataFn: () => ({ healthScore: 87, jobs: { total: 3 } }) as any,
    });

    const chunks: string[] = [];
    const res = {
      writeHead: vi.fn(),
      write: vi.fn((s: string) => chunks.push(s)),
      end: vi.fn(),
    } as any;
    const req = {
      url: "/api/events",
      headers: { host: "localhost:3333" },
      on: vi.fn(),
    } as any;

    handler(req, res);

    expect(chunks[0]).toContain("event: init");
    expect(chunks[0]).toContain('"healthScore":87');
  });

  it("adds client to set and removes on close", () => {
    const sseClients = new Set<SSEClient>();
    const handler = createRequestHandler({
      projectDir: "/tmp",
      checkpointDir: "/tmp/.garyclaw",
      webAssetsDir: "/tmp",
      sseClients,
      loadDashboardDataFn: () => ({}) as any,
    });

    const listeners: Record<string, Function> = {};
    const res = {
      writeHead: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
    } as any;
    const req = {
      url: "/api/events",
      headers: { host: "localhost:3333" },
      on: vi.fn((event: string, cb: Function) => { listeners[event] = cb; }),
    } as any;

    handler(req, res);
    expect(sseClients.size).toBe(1);
    expect(sseClients.has(res)).toBe(true);

    // Simulate client disconnect
    listeners["close"]();
    expect(sseClients.size).toBe(0);
  });

  it("handles loadDashboardData error gracefully on SSE init", () => {
    const sseClients = new Set<SSEClient>();
    const handler = createRequestHandler({
      projectDir: "/tmp",
      checkpointDir: "/tmp/.garyclaw",
      webAssetsDir: "/tmp",
      sseClients,
      loadDashboardDataFn: () => { throw new Error("boom"); },
    });

    const chunks: string[] = [];
    const res = {
      writeHead: vi.fn(),
      write: vi.fn((s: string) => chunks.push(s)),
      end: vi.fn(),
    } as any;
    const req = {
      url: "/api/events",
      headers: { host: "localhost:3333" },
      on: vi.fn(),
    } as any;

    handler(req, res);
    // Should still send init event (empty object fallback)
    expect(chunks[0]).toContain("event: init");
    expect(sseClients.size).toBe(1);
  });

  it("multiple clients receive broadcasts", () => {
    const sseClients = new Set<SSEClient>();
    const c1 = mockSSEClient();
    const c2 = mockSSEClient();
    sseClients.add(c1);
    sseClients.add(c2);

    broadcastSSE(sseClients, "commit", { sha: "abc123", author: "daemon" });
    expect(c1.chunks).toHaveLength(1);
    expect(c2.chunks).toHaveLength(1);
    expect(c1.chunks[0]).toContain('"sha":"abc123"');
  });
});

// ── File Watcher ─────────────────────────────────────────────────

describe("createFileWatcher", () => {
  it("returns null for non-existent directory", () => {
    const handle = createFileWatcher("/tmp/nonexistent-garyclaw-dir", "/tmp", new Set());
    expect(handle).toBeNull();
  });

  it("returns handle with close() for existing directory", () => {
    const dir = tmpDir();
    const handle = createFileWatcher(dir, "/tmp", new Set());
    expect(handle).not.toBeNull();
    expect(typeof handle!.close).toBe("function");
    handle!.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("close() does not throw", () => {
    const dir = tmpDir();
    const handle = createFileWatcher(dir, "/tmp", new Set());
    expect(() => handle!.close()).not.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });
});

// ── File-to-Event Mapping (comprehensive) ────────────────────────

describe("mapFileToEventType comprehensive", () => {
  const cases: Array<[string, string | null]> = [
    // Direct matches
    ["daemon-state.json", "job_update"],
    ["global-budget.json", "budget"],
    ["priority.md", "job_update"],
    ["pipeline-outcomes.jsonl", "mutation"],
    // Nested oracle-memory files
    ["oracle-memory/decision-outcomes.md", "decision"],
    ["oracle-memory/metrics.json", "decision"],
    ["oracle-memory/taste.md", "taste_update"],
    ["oracle-memory/domain-expertise.md", "expertise_update"],
    // Todo state files
    ["todo-state/add-live-dashboard.json", "mutation"],
    ["todo-state/fix-bug-123.json", "mutation"],
    // Files we don't track
    ["checkpoint.json", null],
    ["dogfood-report.md", null],
    ["daemon.log", null],
    ["some-random.txt", null],
    // Windows paths
    ["oracle-memory\\taste.md", "taste_update"],
    ["todo-state\\some-task.json", "mutation"],
  ];

  for (const [filename, expected] of cases) {
    it(`maps "${filename}" to ${expected === null ? "null" : `"${expected}"`}`, () => {
      expect(mapFileToEventType(filename)).toBe(expected);
    });
  }
});
