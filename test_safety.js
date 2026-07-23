// Safety regression tests for the Kalshi API client.
// Asserts that no transfer/deposit/withdraw endpoint can ever be called.

import { kalshiAuthedFetch } from "./netlify/functions/jackson.js";

// Mock env so we get past the credential check and reach the guard.
process.env.KALSHI_ACCESS_KEY_ID = process.env.KALSHI_ACCESS_KEY_ID || "test-id";
process.env.KALSHI_PRIVATE_KEY = process.env.KALSHI_PRIVATE_KEY || `-----BEGIN RSA PRIVATE KEY-----
MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu
KUpRKfFLfRYC9AIKjbJTWit+CqvjWYzvQwECAwEAAQJAIJLixBy2qpFoS4DSmoEm
o3qGy0t6z09AIJtH+5OeRV1be+N4cDYJKffGzDa88vQENZiRm0GRq6a+HPGQMd2k
TQIhAKMSvzIBnni7ot/OSie2TmJLY4SwTQAevXysE2RbFDYdAiEBCUEaRQnMnbp7
9mxDXDf6AU0cN/RPBjb9qSHDcWZHGzUCIG2Es59z8ugGrDY+pxLQnwfotadxd+Uy
v/Ow5T0q5gIJAiEAyS4RaI9YG8EWx/2w0T67ZUVAw8eOMB6BIUg0Xcu+3okCIBOs
/5OiPgoTdSy7bcF9IGpSE8ZgGKzgYQVZeN97YE00
-----END RSA PRIVATE KEY-----`;

const tests = [
  // Should throw "not on allowlist".
  { name: "deposits path",          path: "/trade-api/v2/portfolio/exchange-deposits", expectThrow: /allowlist/ },
  { name: "withdrawals path",       path: "/trade-api/v2/portfolio/exchange-withdrawals", expectThrow: /allowlist/ },
  { name: "transfers path",         path: "/trade-api/v2/portfolio/transfers", expectThrow: /allowlist|denylist/ },
  { name: "bank-link path",         path: "/trade-api/v2/account/bank", expectThrow: /allowlist|denylist/ },
  { name: "ach path",               path: "/trade-api/v2/portfolio/ach", expectThrow: /allowlist|denylist/ },
  { name: "wire path",              path: "/trade-api/v2/portfolio/wire-transfer", expectThrow: /allowlist|denylist/ },
  { name: "non-portfolio path",     path: "/trade-api/v2/admin/whatever", expectThrow: /allowlist/ },
  { name: "unknown path",           path: "/trade-api/v2/bogus", expectThrow: /allowlist/ },
  // Should NOT throw on guard (will fail later on signature/auth, but the guard passes).
  { name: "balance (allowed)",      path: "/trade-api/v2/portfolio/balance", expectThrow: false },
  { name: "positions (allowed)",    path: "/trade-api/v2/portfolio/positions?limit=5", expectThrow: false },
  { name: "orders (allowed)",       path: "/trade-api/v2/portfolio/orders", expectThrow: false },
  { name: "V2 order create (allowed)", path: "/trade-api/v2/portfolio/events/orders", expectThrow: false },
  { name: "fills (allowed)",        path: "/trade-api/v2/portfolio/fills", expectThrow: false }
];

let pass = 0, fail = 0;
for (const t of tests) {
  let threw = null;
  try {
    await kalshiAuthedFetch("GET", t.path);
  } catch (e) {
    threw = e.message;
  }
  if (t.expectThrow) {
    if (threw && t.expectThrow.test(threw)) {
      console.log(`  ✓ ${t.name.padEnd(30)} blocked: ${threw.slice(0, 80)}`);
      pass++;
    } else {
      console.log(`  ✗ ${t.name.padEnd(30)} expected to be blocked but was not (threw: ${threw})`);
      fail++;
    }
  } else {
    // Should pass guard. May still throw later from network/auth, but not from guard.
    if (threw == null || (!/allowlist|denylist/.test(threw))) {
      console.log(`  ✓ ${t.name.padEnd(30)} guard passed (post-guard error ok)`);
      pass++;
    } else {
      console.log(`  ✗ ${t.name.padEnd(30)} guard incorrectly blocked: ${threw}`);
      fail++;
    }
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
