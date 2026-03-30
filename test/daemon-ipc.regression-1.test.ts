/**
 * Regression: ISSUE-001 — IPC server had no per-connection timeout or buffer cap
 * Found by /qa on 2026-03-30
 * Report: .gstack/qa-reports/qa-report-garyclaw-2026-03-30.md
 *
 * A hung CLI that connected but never sent data kept the connection open
 * indefinitely, and the data buffer accumulated without limit.
 */

import { describe, it, expect } from "vitest";
import { IPC_CONNECTION_TIMEOUT_MS, IPC_MAX_BUFFER_BYTES } from "../src/daemon-ipc.js";

describe("IPC server connection safeguards", () => {
  it("exports a non-zero connection timeout constant", () => {
    expect(IPC_CONNECTION_TIMEOUT_MS).toBeGreaterThan(0);
    expect(IPC_CONNECTION_TIMEOUT_MS).toBe(30_000);
  });

  it("exports a non-zero buffer cap constant", () => {
    expect(IPC_MAX_BUFFER_BYTES).toBeGreaterThan(0);
    expect(IPC_MAX_BUFFER_BYTES).toBe(1_048_576); // 1 MiB
  });

  it("buffer cap is large enough for legitimate requests but bounded", () => {
    // Legitimate IPC requests are small JSON (~100-500 bytes).
    // 1 MiB is generous but still prevents unbounded growth.
    expect(IPC_MAX_BUFFER_BYTES).toBeGreaterThanOrEqual(1024);
    expect(IPC_MAX_BUFFER_BYTES).toBeLessThanOrEqual(10 * 1024 * 1024);
  });
});
