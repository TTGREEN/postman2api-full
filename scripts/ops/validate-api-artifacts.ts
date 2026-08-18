import { readFileSync } from "node:fs";

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const openapi = readJson("docs/openapi.json");
const collection = readJson("examples/postman2api.postman_collection.json");

const requiredPaths = ["/health", "/v1/models", "/v1/chat/completions", "/v1/messages"];
assert(openapi.openapi?.startsWith("3."), "OpenAPI version must be 3.x");
for (const path of requiredPaths) {
  assert(openapi.paths?.[path], `OpenAPI missing ${path}`);
}
assert(openapi.components?.securitySchemes?.BearerAuth, "OpenAPI missing BearerAuth");
assert(openapi.components?.securitySchemes?.ApiKeyAuth, "OpenAPI missing ApiKeyAuth");

const itemNames = new Set((collection.item || []).map((item: any) => item.name));
for (const name of ["Health", "Models", "OpenAI Chat Completion", "Anthropic Messages"]) {
  assert(itemNames.has(name), `Postman collection missing ${name}`);
}
const serialized = JSON.stringify({ openapi, collection }).toLowerCase();
for (const forbidden of ["postman_sid", "session_value", "cookie", "tokens/"]) {
  assert(!serialized.includes(forbidden), `API artifacts include forbidden token marker: ${forbidden}`);
}
console.log("API artifacts OK: docs/openapi.json and examples/postman2api.postman_collection.json");
