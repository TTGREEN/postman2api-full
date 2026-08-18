import { RegistrationRuntime } from "../../src/automation-lab/registration-runtime.ts";

const runtime = new RegistrationRuntime({ broadcast: () => {} });
const started = await runtime.start({ target: "postman", count: 1, retryLimit: 0, mode: "upstream" });
let snapshot = started;
const deadline = Date.now() + 10_000;
while (Date.now() < deadline && (snapshot.status === "queued" || snapshot.status === "running")) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  snapshot = await runtime.readSnapshot(started.id);
}
console.log(JSON.stringify({ id: snapshot.id, status: snapshot.status, completed: snapshot.completed, error: snapshot.error, events: snapshot.events.slice(-8) }, null, 2));
const workerBoot = snapshot.events.find((event) => event.stage === "worker" && event.message === "注册 Worker 已启动");
if (!workerBoot || workerBoot.payload?.skipBrowserDownload !== true) {
  throw new Error("注册 Worker 未确认本地浏览器启动配置");
}
await runtime.shutdown();
