/**
 * Daemon IPC — Unix domain socket protocol for CLI ↔ daemon communication.
 *
 * Protocol: newline-delimited JSON, one request-response per connection.
 * Client connects, sends JSON + newline, server responds with JSON + newline, both close.
 */

import { createServer, createConnection } from "node:net";
import type { Server } from "node:net";
import type { IPCRequest, IPCResponse } from "./types.js";

export type IPCHandler = (request: IPCRequest) => Promise<IPCResponse>;

/**
 * Create an IPC server listening on a Unix domain socket.
 * Each connection expects one JSON request line and sends one JSON response line.
 * Processes as soon as the newline delimiter arrives (not on connection end).
 */
/** Per-connection idle timeout (ms). Hung clients that connect but never send data get cleaned up. */
export const IPC_CONNECTION_TIMEOUT_MS = 30_000;

/** Maximum buffer size per connection (bytes). Prevents unbounded memory growth from misbehaving clients. */
export const IPC_MAX_BUFFER_BYTES = 1_048_576; // 1 MiB

export function createIPCServer(socketPath: string, handler: IPCHandler): Server {
  const server = createServer((conn) => {
    let data = "";
    let handled = false;

    // Per-connection timeout: destroy hung connections that never send data
    conn.setTimeout(IPC_CONNECTION_TIMEOUT_MS, () => {
      if (!handled) {
        conn.destroy();
      }
    });

    async function handleRequest(): Promise<void> {
      if (handled) return;
      const newlineIdx = data.indexOf("\n");
      if (newlineIdx < 0) return; // Not enough data yet

      handled = true;
      const jsonStr = data.slice(0, newlineIdx);

      let response: IPCResponse;
      try {
        const request = JSON.parse(jsonStr) as IPCRequest;

        if (!request || typeof request !== "object" || !request.type) {
          response = { ok: false, error: "Invalid request: missing type" };
        } else {
          response = await handler(request);
        }
      } catch (err) {
        response = {
          ok: false,
          error: `IPC error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      try {
        conn.end(JSON.stringify(response) + "\n");
      } catch {
        // Connection may have closed
      }
    }

    conn.on("data", (chunk) => {
      data += chunk.toString();
      // Buffer size cap: prevent unbounded memory growth from misbehaving clients
      if (data.length > IPC_MAX_BUFFER_BYTES) {
        if (!handled) {
          handled = true;
          try {
            conn.end(JSON.stringify({ ok: false, error: "Request too large" } satisfies IPCResponse) + "\n");
          } catch { /* connection may have closed */ }
        }
        return;
      }
      handleRequest().catch((err) => {
        // Prevent unhandled promise rejection from crashing the daemon
        // but log the error for debuggability
        console.error("[IPC] Unexpected error handling request:", err instanceof Error ? err.message : String(err));
      });
    });

    conn.on("end", () => {
      // If we haven't processed yet (e.g., no newline), try with what we have
      if (!handled && data.length > 0) {
        data += "\n"; // Treat end-of-stream as delimiter
        handleRequest().catch((err) => {
          // Prevent unhandled promise rejection from crashing the daemon
          console.error("[IPC] Unexpected error handling request on end:", err instanceof Error ? err.message : String(err));
        });
      }
    });

    conn.on("error", () => {
      // Client disconnected unexpectedly — nothing to do
    });
  });

  server.listen(socketPath);
  return server;
}

/**
 * Send an IPC request to the daemon and return the response.
 * Connects to the Unix socket, sends JSON + newline, reads JSON response.
 */
export function sendIPCRequest(
  socketPath: string,
  request: IPCRequest,
  timeoutMs: number = 5000,
): Promise<IPCResponse> {
  return new Promise((resolve, reject) => {
    const conn = createConnection(socketPath);
    let data = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        conn.destroy();
        reject(new Error("IPC request timed out"));
      }
    }, timeoutMs);

    conn.on("connect", () => {
      conn.write(JSON.stringify(request) + "\n");
    });

    conn.on("data", (chunk) => {
      data += chunk.toString();
      // Try to parse as soon as we get a newline
      const newlineIdx = data.indexOf("\n");
      if (newlineIdx >= 0 && !settled) {
        settled = true;
        clearTimeout(timer);
        try {
          resolve(JSON.parse(data.slice(0, newlineIdx)) as IPCResponse);
        } catch {
          reject(new Error(`Invalid IPC response: ${data.slice(0, 200)}`));
        }
        conn.end();
      }
    });

    conn.on("end", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (data.length > 0) {
        try {
          resolve(JSON.parse(data.trim()) as IPCResponse);
        } catch {
          reject(new Error(`Invalid IPC response: ${data.slice(0, 200)}`));
        }
      } else {
        reject(new Error("IPC: server closed without response"));
      }
    });

    conn.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`IPC connection error: ${err.message}`));
    });
  });
}
