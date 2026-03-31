/**
 * Dashboard web asset smoke tests — verify static files exist, contain expected content,
 * and total size is under budget. No browser testing (this is a library project).
 */

import { describe, it, expect } from "vitest";
import { readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WEB_DIR = join(__dirname, "..", "src", "dashboard-web");

describe("dashboard-web assets", () => {
  it("index.html exists and contains tab structure", () => {
    const path = join(WEB_DIR, "index.html");
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf-8");
    expect(content).toContain('data-tab="live"');
    expect(content).toContain('data-tab="mutations"');
    expect(content).toContain('data-tab="growth"');
    expect(content).toContain('data-tab="mind"');
    expect(content).toContain("GARY");
    expect(content).toContain("CLAW");
    expect(content).toContain("view-live");
    expect(content).toContain("view-mutations");
    expect(content).toContain("view-growth");
    expect(content).toContain("view-mind");
  });

  it("style.css exists and contains CSS variables", () => {
    const path = join(WEB_DIR, "style.css");
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("--bg:");
    expect(content).toContain("--surface:");
    expect(content).toContain("--accent:");
    expect(content).toContain("--green:");
    expect(content).toContain("--red:");
    expect(content).toContain("#0d1117"); // GitHub dark bg
  });

  it("app.js exists and contains EventSource usage", () => {
    const path = join(WEB_DIR, "assets", "app.js");
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("EventSource");
    expect(content).toContain("/api/events");
    expect(content).toContain("/api/state");
    expect(content).toContain("/api/decisions");
    expect(content).toContain("/api/mutations");
    expect(content).toContain("/api/growth");
  });

  it("charts.js exists and contains chart functions", () => {
    const path = join(WEB_DIR, "assets", "charts.js");
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf-8");
    expect(content).toContain("createBarChart");
    expect(content).toContain("createSparkline");
    expect(content).toContain("createProgressBar");
    expect(content).toContain("createConfidenceBar");
    expect(content).toContain("formatUsd");
    expect(content).toContain("formatDuration");
  });

  it("total file size is under 100KB", () => {
    const files = [
      join(WEB_DIR, "index.html"),
      join(WEB_DIR, "style.css"),
      join(WEB_DIR, "assets", "app.js"),
      join(WEB_DIR, "assets", "charts.js"),
    ];
    let totalBytes = 0;
    for (const f of files) {
      totalBytes += statSync(f).size;
    }
    const totalKB = totalBytes / 1024;
    expect(totalKB).toBeLessThan(100);
  });

  it("no external URL references (no CDN links)", () => {
    const files = [
      join(WEB_DIR, "index.html"),
      join(WEB_DIR, "style.css"),
      join(WEB_DIR, "assets", "app.js"),
      join(WEB_DIR, "assets", "charts.js"),
    ];
    for (const f of files) {
      const content = readFileSync(f, "utf-8");
      // Should not reference external CDNs
      expect(content).not.toContain("cdn.jsdelivr");
      expect(content).not.toContain("cdnjs.cloudflare");
      expect(content).not.toContain("unpkg.com");
      expect(content).not.toContain("https://");
    }
  });

  it("index.html references both script files", () => {
    const content = readFileSync(join(WEB_DIR, "index.html"), "utf-8");
    expect(content).toContain("/assets/charts.js");
    expect(content).toContain("/assets/app.js");
    expect(content).toContain("/style.css");
  });
});
