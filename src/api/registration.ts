import { Hono, type Context } from "hono";
import { RegistrationJobBusyError, registrationRuntime, type RegistrationRuntime } from "../automation-lab/registration-runtime";
import type { RegistrationJobMode } from "../automation-lab/registration-types";

function parseListMode(c: Context): RegistrationJobMode | undefined {
  const mode = c.req.query("mode");
  if (mode === undefined || mode === "") return undefined;
  if (mode === "upstream") return mode;
  throw new Error("本地模拟自动化已下线，仅支持真实上游注册任务");
}

function parseListLimit(c: Context): number | undefined {
  const raw = c.req.query("limit");
  if (raw === undefined || raw === "") return undefined;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be an integer from 1 to 100");
  return limit;
}

export function createRegistrationRouter(runtime: RegistrationRuntime = registrationRuntime): Hono {
  const router = new Hono();

  router.get("/", async (c) => {
    try {
      return c.json({ data: await runtime.list({ mode: parseListMode(c), limit: parseListLimit(c) }) });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "注册任务列表参数错误" }, 400);
    }
  });
  router.get("/:id", async (c) => {
    try { return c.json(await runtime.readSnapshot(c.req.param("id"))); }
    catch { return c.json({ error: "注册任务不存在" }, 404); }
  });
  router.post("/", async (c) => {
    const body = await c.req.json().catch(() => null);
    try { return c.json(await runtime.start(body), 202); }
    catch (error) {
      if (error instanceof RegistrationJobBusyError) return c.json({ error: error.message }, 409);
      return c.json({ error: error instanceof Error ? error.message : "注册任务启动失败" }, 400);
    }
  });
  router.post("/:id/stop", async (c) => {
    try { return c.json(await runtime.stop(c.req.param("id"))); }
    catch { return c.json({ error: "注册任务不存在" }, 404); }
  });
  router.post("/:id/retry", async (c) => {
    try { return c.json(await runtime.retry(c.req.param("id")), 202); }
    catch (error) {
      if (error instanceof RegistrationJobBusyError) return c.json({ error: error.message }, 409);
      return c.json({ error: error instanceof Error ? error.message : "注册任务重试失败" }, 400);
    }
  });
  return router;
}

export const registrationRouter = createRegistrationRouter();
