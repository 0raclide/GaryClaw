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
export function createIPCServer(socketPath: string, handler: IPCHandler): Server {
  const server = createServer((conn) => {
    let data = "";
    let handled = false;

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
      handleRequest();
    });

    conn.on("end", () => {
      // If we haven't processed yet (e.g., no newline), try with what we have
      if (!handled && data.length > 0) {
        data += "\n"; // Treat end-of-stream as delimiter
        handleRequest();
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
