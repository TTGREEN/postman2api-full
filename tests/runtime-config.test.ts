import { describe, expect, test } from "bun:test";
import { config } from "../src/config";

describe("runtime network binding", () => {
  test("defaults to loopback for local deployments", () => {
    expect(config.host).toBe("127.0.0.1");
  });
});
