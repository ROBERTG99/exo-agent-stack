import { describe, expect, it } from "vitest";
import { isLocalServiceUrl } from "@exos/common";

describe("isLocalServiceUrl", () => {
  it.each([
    "http://127.0.0.1:9812",
    "http://127.1.2.3:9812/api",
    "http://localhost:9812",
    "http://[::1]:9812",
    "http://stackd:9812", // a compose service name has no dots and only resolves on the local network
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
