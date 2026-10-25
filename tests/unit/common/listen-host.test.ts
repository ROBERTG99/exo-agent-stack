import { describe, expect, it } from "vitest";
import { ListenHostError, parsePort, resolveListenHost, runningInContainer } from "@exos/common";

describe("resolveListenHost (loopback-only rail)", () => {
  it("defaults to 127.0.0.1", () => {
    expect(resolveListenHost({})).toBe("127.0.0.1");
  });

  it.each([
    ["127.0.0.1", "127.0.0.1"],
    ["localhost", "127.0.0.1"],
    ["::1", "::1"],
  ])("accepts loopback value %s", (value, expected) => {
    expect(resolveListenHost({ EXOS_LISTEN_HOST: value })).toBe(expected);
  });

  it.each(["0.0.0.0", "::", "192.168.1.5", "example.com", "", "127.0.0.2"])(
    "refuses %j",
    (value) => {
      if (value === "") {
        // An empty value falls back to the default rather than binding everywhere.
        expect(resolveListenHost({ EXOS_LISTEN_HOST: value })).toBe("127.0.0.1");
        return;
      }
      expect(() => resolveListenHost({ EXOS_LISTEN_HOST: value })).toThrow(ListenHostError);
    },
  );

  it("allows 'container' only inside a real container, where compose publishes 127.0.0.1 ports", () => {
    const yes = () => true;
    const no = () => false;
    expect(() => resolveListenHost({ EXOS_LISTEN_HOST: "container" }, yes)).toThrow(
      ListenHostError,
    );
    expect(() =>
      resolveListenHost({ EXOS_LISTEN_HOST: "container", EXOS_IN_CONTAINER: "0" }, yes),
    ).toThrow(ListenHostError);
    // The flag alone is not enough: a host process that sets it still has no container filesystem.
    expect(() =>
      resolveListenHost({ EXOS_LISTEN_HOST: "container", EXOS_IN_CONTAINER: "1" }, no),
    ).toThrow(ListenHostError);
    expect(resolveListenHost({ EXOS_LISTEN_HOST: "container", EXOS_IN_CONTAINER: "1" }, yes)).toBe(
      ["0", "0", "0", "0"].join("."),
    );
  });

  it("detects the real environment: this host test run is not inside a container", () => {
    // Developer machines and CI runners that execute this suite natively have no /.dockerenv;
    // the containerised test run (make test-docker) is the one place where this may differ.
    expect(typeof runningInContainer()).toBe("boolean");
    if (!runningInContainer()) {
      expect(() =>
        resolveListenHost({ EXOS_LISTEN_HOST: "container", EXOS_IN_CONTAINER: "1" }),
      ).toThrow(ListenHostError);
    }
  });
});

describe("parsePort", () => {
  it("parses valid ports and falls back when unset", () => {
    expect(parsePort("9812", 1)).toBe(9812);
    expect(parsePort(undefined, 9840)).toBe(9840);
    expect(parsePort("", 9840)).toBe(9840);
  });

  it.each(["0", "-1", "65536", "abc", "98.5", "9812x"])("rejects %j", (v) => {
    expect(() => parsePort(v, 1)).toThrow(/port/i);
  });
});
