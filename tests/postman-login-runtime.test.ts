import { describe, expect, test } from "bun:test";
import { loginPostmanForRuntime } from "../src/auth/postman-login-runtime";

const result = {
  postman_sid: "sid",
  user_id: "user",
  workspace_id: "workspace",
  workspace_subdomain: "team",
};

describe("Postman login runtime selection", () => {
  test("runs Camoufox login in a Node worker when the service uses Bun", async () => {
    const calls: string[] = [];
    const received = await loginPostmanForRuntime("user@example.com", {}, {
      runtime: "bun",
      backend: "camoufox",
      directRunner: async () => { calls.push("direct"); return result; },
      workerRunner: async () => { calls.push("worker"); return result; },
    });

    expect(received).toEqual(result);
    expect(calls).toEqual(["worker"]);
  });

  test("keeps Node and Playwright flows in the current process", async () => {
    for (const [runtime, backend] of [["node", "camoufox"], ["bun", "playwright"]] as const) {
      const calls: string[] = [];
      await loginPostmanForRuntime(undefined, {}, {
        runtime,
        backend,
        directRunner: async () => { calls.push("direct"); return result; },
        workerRunner: async () => { calls.push("worker"); return result; },
      });
      expect(calls).toEqual(["direct"]);
    }
  });
});
