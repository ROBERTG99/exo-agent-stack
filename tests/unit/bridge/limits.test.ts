import { describe, expect, it } from "vitest";
import {
  LIMITS,
  RateLimiter,
  checkPrompt,
  clipText,
  parseHostHeader,
} from "../../../bridge/src/limits.ts";

describe("RateLimiter (NFR-8: 60 calls per minute)", () => {
  const at = (t: number) => ({ now: () => t });

  it("allows the limit and refuses the next call, with the time to wait", () => {
    let t = 0;
    const limiter = new RateLimiter(3, 60_000, () => t);
    for (let i = 0; i < 3; i++) {
      t += 1_000;
      expect(limiter.take()).toEqual({ ok: true });
    }
    t += 1_000;
    const refused = limiter.take();
    expect(refused.ok).toBe(false);
    // the first call (t=1000) leaves the window at t=61000; now is 4000
    expect(refused).toMatchObject({ ok: false, retryAfterMs: 57_000 });
  });

  it("lets calls through again as old ones leave the window", () => {
    let t = 0;
    const limiter = new RateLimiter(2, 10_000, () => t);
    limiter.take();
    t = 5_000;
    limiter.take();
    expect(limiter.take().ok).toBe(false);
    t = 10_001; // the first call is out of the window
    expect(limiter.take().ok).toBe(true);
    expect(limiter.take().ok).toBe(false);
  });

  it("does not count a refused call against the window", () => {
    let t = 0;
    const limiter = new RateLimiter(1, 10_000, () => t);
    limiter.take();
    for (let i = 0; i < 50; i++) {
      t += 100;
      expect(limiter.take().ok).toBe(false);
    }
    t = 10_001;
    expect(limiter.take().ok).toBe(true);
  });

  it("defaults to 60 a minute", () => {
    const limiter = new RateLimiter();
    const results = Array.from({ length: 61 }, () => limiter.take().ok);
    expect(results.filter(Boolean)).toHaveLength(60);
    expect(results[60]).toBe(false);
    expect(LIMITS.callsPerMinute).toBe(60);
    void at;
  });

  it("rejects a nonsensical configuration", () => {
    expect(() => new RateLimiter(0)).toThrow();
    expect(() => new RateLimiter(5, 0)).toThrow();
  });
});

describe("text limits", () => {
  it("accepts a prompt up to 20,000 characters and refuses more or none", () => {
    expect(LIMITS.promptChars).toBe(20_000);
    expect(checkPrompt("x".repeat(20_000))).toBe(true);
    expect(checkPrompt("x".repeat(20_001))).toBe(false);
    expect(checkPrompt("")).toBe(false);
  });

  it("cuts event text at 4,000 characters and says so", () => {
    expect(LIMITS.eventTextChars).toBe(4_000);
    expect(clipText("short")).toEqual({ text: "short", truncated: false });
    const exact = "y".repeat(4_000);
    expect(clipText(exact)).toEqual({ text: exact, truncated: false });
    const cut = clipText("z".repeat(5_000));
    expect(cut.truncated).toBe(true);
    expect(cut.text.startsWith("z".repeat(4_000))).toBe(true);
    expect(cut.text).toContain("1000 more characters");
  });

  it("cuts on a character boundary, not in the middle of a surrogate pair", () => {
    const text = `${"a".repeat(3_999)}😀tail`;
    const cut = clipText(text);
    expect(cut.truncated).toBe(true);
    expect(() => encodeURIComponent(cut.text)).not.toThrow();
  });
});

describe("parseHostHeader", () => {
  it("splits a Host header into name and port", () => {
    expect(parseHostHeader("127.0.0.1:9811")).toEqual({ name: "127.0.0.1", port: 9811 });
    expect(parseHostHeader("LOCALHOST:9811")).toEqual({ name: "localhost", port: 9811 });
    expect(parseHostHeader("[::1]:9811")).toEqual({ name: "[::1]", port: 9811 });
    expect(parseHostHeader("localhost")).toEqual({ name: "localhost", port: undefined });
    expect(parseHostHeader(undefined)).toBeNull();
    expect(parseHostHeader("")).toBeNull();
    expect(parseHostHeader("a b")).toBeNull();
  });
});
