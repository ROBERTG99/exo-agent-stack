import { describe, expect, it } from "vitest";
import { isLocalServiceUrl } from "@exos/common";

describe("isLocalServiceUrl", () => {
  it.each([
    "http://127.0.0.1:9812",
    "http://127.1.2.3:9812/api",
    "http://localhost:9812",
    "http://[::1]:9812",
    "http://stackd:9812", // the compose service name, on the allowlist
    "https://localhost",
  ])("accepts %s", (url) => {
    expect(isLocalServiceUrl(url)).toBe(true);
  });

  it.each([
    "http://evil.example:9812",
    "http://203.0.113.5:9812",
    "http://192.168.1.20:9812",
    "http://0.0.0.0:9812",
    "http://stackd.evil.example:9812",
    "http://intranet:9812", // a dotless name can resolve anywhere through a search domain
    "http://stackd2:9812",
    "http://STACKD.corp:9812",
    "http://127.0.0.1.evil.example:9812",
    "http://user:pw@evil.example",
    "ftp://127.0.0.1",
    "file:///etc/passwd",
    "not a url",
    "",
  ])("refuses %s", (url) => {
    expect(isLocalServiceUrl(url)).toBe(false);
  });
});

describe("isLocalServiceUrl with extra allowed names", () => {
  it("accepts only the names it is given, besides loopback", () => {
    expect(isLocalServiceUrl("http://bridge:9811", ["bridge"])).toBe(true);
    expect(isLocalServiceUrl("http://STACKD:9812", ["stackd"])).toBe(true);
    expect(isLocalServiceUrl("http://stackd:9812", [])).toBe(false);
    expect(isLocalServiceUrl("http://127.0.0.1:9812", [])).toBe(true);
  });
});
