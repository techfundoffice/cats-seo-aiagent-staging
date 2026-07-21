import { bench, describe } from "vitest";
import { redactSecrets } from "../http-utils";

// Baseline numbers for the central redaction choke point. redactSecrets
// runs once per agent.log() call in production. If these regressed by
// 10x someone added a catastrophic regex; this benchmark surfaces it.
// Run with `npm run bench`.

function buildPayload(sizeBytes: number, secretsPerKB: number): string {
  const secrets = [
    "Authorization: Bearer sk-ant-abcdefghijklmnopqrst",
    "Cookie: session=abcdefghijklmnopqrstuvwxyz1234567890",
    "Stripe: sk_live_abcdefghij" + "klmnopqrstuvwx",
    "https://b.s3.amazonaws.com/k?X-Amz-Signature=abc123def456ghi789jkl",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
  ];
  const totalSecrets = Math.max(
    1,
    Math.round((sizeBytes / 1024) * secretsPerKB)
  );
  const filler = "x".repeat(Math.max(1, Math.floor(sizeBytes / totalSecrets)));
  let out = "";
  for (let i = 0; i < totalSecrets; i++) {
    out += filler + " " + secrets[i % secrets.length] + " ";
    if (out.length >= sizeBytes) break;
  }
  return out.slice(0, sizeBytes);
}

const PAYLOAD_1KB = buildPayload(1024, 2);
const PAYLOAD_10KB = buildPayload(10 * 1024, 2);
const PAYLOAD_100KB = buildPayload(100 * 1024, 2);
const PAYLOAD_CLEAN_1KB = "x".repeat(1024);

describe("redactSecrets — performance", () => {
  bench("1 KB payload, ~2 secrets", () => {
    redactSecrets(PAYLOAD_1KB);
  });

  bench("10 KB payload, ~20 secrets", () => {
    redactSecrets(PAYLOAD_10KB);
  });

  bench("100 KB payload, ~200 secrets", () => {
    redactSecrets(PAYLOAD_100KB);
  });

  bench("1 KB payload, NO secrets (fast path)", () => {
    redactSecrets(PAYLOAD_CLEAN_1KB);
  });
});
