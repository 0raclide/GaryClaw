import { describe, it, expect, vi } from "vitest";
import { resolveWarnFn } from "../src/types.js";
import type { WarnFn } from "../src/types.js";

describe("resolveWarnFn", () => {
  it("returns provided callback when given", () => {
    const custom: WarnFn = vi.fn();
    const warn = resolveWarnFn(custom);
    warn("test message");
    expect(custom).toHaveBeenCalledWith("test message");
  });

  it("returns console.warn when no callback provided", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const warn = resolveWarnFn();
    warn("fallback message");
    expect(spy).toHaveBeenCalledWith("fallback message");
    spy.mockRestore();
  });

  it("returns console.warn when undefined is passed explicitly", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const warn = resolveWarnFn(undefined);
    warn("explicit undefined");
    expect(spy).toHaveBeenCalledWith("explicit undefined");
    spy.mockRestore();
  });
});
