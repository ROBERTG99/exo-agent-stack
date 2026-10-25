import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "@exos/common";

describe("canonicalJson", () => {
  it("sorts object keys recursively and is independent of insertion order", () => {
    expect(canonicalJson({ b: 1, a: { d: 1, c: [3, { z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[3,{"y":2,"z":1}],"d":1},"b":1}',
    );
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it("keeps array order, null and primitives", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson("x")).toBe('"x"');
    expect(canonicalJson(true)).toBe("true");
  });

  it("drops undefined object members like JSON.stringify and rejects non-finite numbers", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(/finite/i);
    expect(() => canonicalJson({ a: Infinity })).toThrow(/finite/i);
  });

  it("rejects values JSON cannot represent", () => {
    expect(() => canonicalJson({ a: 10n })).toThrow(/bigint/i);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(/function/i);
  });

  it("rejects cycles", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => canonicalJson(a)).toThrow(/circular/i);
  });
});

describe("sha256Hex", () => {
  it("matches the known digest of 'abc'", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
