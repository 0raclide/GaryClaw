/**
 * Daemon IPC tests — Unix socket request/response protocol.
 */

import { describe, it, expect, afterEach } from "vitest";
import { unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createServer, createConnection } from "node:net";
import { createIPCServer, sendIPCRequest } from "../src/daemon-ipc.js";
import type { IPCRequest, IPCResponse } from "../src/types.js";
import type { Server } from "node:net";

const SOCK = join(process.cwd(), `.test-ipc-${process.pid}.sock`);

let server: Server | null = null;

function cleanup(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (server) {
      const s = server;
      server = null;
      s.close(() => {
        cleanupSocket();
        resolve();
      });
      // Force resolve after 2s if close hangs
      setTimeout(() => { cleanupSocket(); resolve(); }, 2000);
    } else {
      cleanupSocket();
      resolve();
    }
  });
}

function cleanupSocket(): void {
  if (existsSync(SOCK)) {
    try { unlinkSync(SOCK); } catch { /* ignore */ }
  }
}

afterEach(cleanup, 15000);

function waitForListen(s: Server): Promise<void> {
  return new Promise((resolve) => s.on("listening", resolve));
}

describe("IPC Server + Client", () => {
  it("handles status request", async () => {
    const handler = async (req: IPCRequest): Promise<IPCResponse> => {
      if (req.type === "status") {
        return { ok: true, data: { running: true, uptime: 120 } };
      }
      return { ok: false, error: "unknown" };
    };

    server = createIPCServer(SOCK, handler);
    await waitForListen(server);

    const resp = await sendIPCRequest(SOCK, { type: "status" });
    expect(resp.ok).toBe(true);
    expect(resp.data).toEqual({ running: true, uptime: 120 });
  });

  it("handles trigger request", async () => {
    let receivedSkills: string[] = [];
    const handler = async (req: IPCRequest): Promise<IPCResponse> => {
      if (req.type === "trigger") {
        receivedSkills = req.skills;
        return { ok: true, data: { jobId: "job-001" } };
      }
      return { ok: false, error: "unknown" };
    };

    server = createIPCServer(SOCK, handler);
    await waitForListen(server);

    const resp = await sendIPCRequest(SOCK, { type: "trigger", skills: ["qa", "ship"] });
    expect(resp.ok).toBe(true);
    expect(receivedSkills).toEqual(["qa", "ship"]);
    expect(resp.data).toEqual({ jobId: "job-001" });
  });

  it("handles queue request", async () => {
    const handler = async (req: IPCRequest): Promise<IPCResponse> => {
      if (req.type === "queue") {
        return { ok: true, data: { jobs: [] } };
      }
      return { ok: false, error: "unknown" };
    };

    server = createIPCServer(SOCK, handler);
    await waitForListen(server);

    const resp = await sendIPCRequest(SOCK, { type: "queue" });
    expect(resp.ok).toBe(true);
    expect(resp.data).toEqual({ jobs: [] });
  });

  it("returns error for malformed JSON", async () => {
    const handler = async (): Promise<IPCResponse> => {
      return { ok: true };
    };

    server = createIPCServer(SOCK, handler);
    await waitForListen(server);

    const resp = await new Promise<IPCResponse>((resolve, reject) => {
      const conn = createConnection(SOCK);
      let data = "";
      conn.on("connect", () => {
        conn.write("not-json\n");
      });
      conn.on("data", (chunk) => { data += chunk.toString(); });
      conn.on("end", () => {
        try { resolve(JSON.parse(data.trim())); } catch { reject(new Error("bad response")); }
      });
      conn.on("error", reject);
    });

    expect(resp.ok).toBe(false);
    expect(resp.error).toContain("IPC error");
  });

  it("returns error for missing type field", async () => {
    const handler = async (): Promise<IPCResponse> => {
      return { ok: true };
    };

    server = createIPCServer(SOCK, handler);
    await waitForListen(server);

    const resp = await new Promise<IPCResponse>((resolve, reject) => {
      const conn = createConnection(SOCK);
      let data = "";
      conn.on("connect", () => {
        conn.write(JSON.stringify({ foo: "bar" }) + "\n");
      });
      conn.on("data", (chunk) => { data += chunk.toString(); });
      conn.on("end", () => {
        try { resolve(JSON.parse(data.trim())); } catch { reject(new Error("bad response")); }
      });
      conn.on("error", reject);
    });

    expect(resp.ok).toBe(false);
    expect(resp.error).toContain("Invalid request");
  });

  it("handles handler errors gracefully", async () => {
    const handler = async (): Promise<IPCResponse> => {
      throw new Error("handler boom");
    };

    server = createIPCServer(SOCK, handler);
    await waitForListen(server);

    const resp = await sendIPCRequest(SOCK, { type: "status" });
    expect(resp.ok).toBe(false);
    expect(resp.error).toContain("handler boom");
  });

  it("times out if server never responds", async () => {
    server = createServer((_conn) => {
      // Do nothing — don't close, don't respond
    });
    server.listen(SOCK);
    await waitForListen(server);

    await expect(
      sendIPCRequest(SOCK, { type: "status" }, 200),
    ).rejects.toThrow("timed out");
  }, 10000);

  it("rejects when socket does not exist", async () => {
    await expect(
      sendIPCRequest("/tmp/nonexistent-garyclaw-test.sock", { type: "status" }, 500),
    ).rejects.toThrow();
  }, 10000);

  it("handles multiple sequential requests", async () => {
    let callCount = 0;
    const handler = async (): Promise<IPCResponse> => {
      callCount++;
      return { ok: true, data: { count: callCount } };
    };

    server = createIPCServer(SOCK, handler);
    await waitForListen(server);

    const r1 = await sendIPCRequest(SOCK, { type: "status" });
    const r2 = await sendIPCRequest(SOCK, { type: "status" });
    const r3 = await sendIPCRequest(SOCK, { type: "queue" });

    expect(r1.data).toEqual({ count: 1 });
    expect(r2.data).toEqual({ count: 2 });
    expect(r3.data).toEqual({ count: 3 });
  });

  it("handles empty data gracefully", async () => {
    const handler = async (): Promise<IPCResponse> => {
      return { ok: true };
    };

    server = createIPCServer(SOCK, handler);
    await waitForListen(server);

    // Connect and immediately close — server should handle gracefully
    const resp = await new Promise<IPCResponse | null>((resolve, reject) => {
      const conn = createConnection(SOCK);
      let data = "";
      conn.on("connect", () => {
        conn.end(); // Send nothing
      });
      conn.on("data", (chunk) => { data += chunk.toString(); });
      conn.on("end", () => {
        if (data.trim().length === 0) {
          resolve(null); // Server didn't respond (expected for empty input)
        } else {
          try { resolve(JSON.parse(data.trim())); } catch { reject(new Error("bad response")); }
        }
      });
      conn.on("error", () => resolve(null)); // Connection error is also acceptable
    });

    // Either null (no response) or an error response — both are valid
    if (resp !== null) {
      expect(resp.ok).toBe(false);
    }
  });
});
