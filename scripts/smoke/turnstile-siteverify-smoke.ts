import { verifyTurnstile } from "../../src/security/turnstile";

// Cloudflare's documented test secret accepts the documented dummy token.
// This script validates only the server-side integration path; it does not touch the upstream automation flow.
const TEST_SECRET = "1x0000000000000000000000000000000AA";
const TEST_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

const result = await verifyTurnstile({ token: TEST_TOKEN, secret: TEST_SECRET });
console.log(JSON.stringify({ scenario: "turnstile-test-secret", result }));
if (!result.ok) process.exitCode = 1;
