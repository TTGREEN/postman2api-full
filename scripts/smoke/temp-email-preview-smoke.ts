import { createServer } from "node:http";
import { createTempEmailPreviewWorker } from "../../src/auth/temp-email-preview-runtime.ts";

const fixture = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html>
    <html><body>
      <label for="mail">Temporary email</label>
      <input id="mail" value="preview.smoke@example.test" />
      <main id="inbox">Inbox is ready</main>
    </body></html>`);
});
await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const address = fixture.address();
if (!address || typeof address === "string") throw new Error("Temporary email fixture failed to listen");

const worker = createTempEmailPreviewWorker({
  headless: true,
  previewUrl: `http://127.0.0.1:${address.port}`,
});
try {
  const email = await worker.ready;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error("Temporary email preview worker returned an invalid email result");
  }
  await worker.focus();
  console.log("Temporary email preview smoke: persistent session focused with valid redacted email result");
} finally {
  await worker.close();
  await new Promise<void>((resolve, reject) => fixture.close((error) => error ? reject(error) : resolve()));
}
