import { createHmac, timingSafeEqual } from "node:crypto";

const SECRET = () => process.env.AUTH_SECRET ?? "";

function makeToken(user) {
  const payload = Buffer.from(JSON.stringify({ user, exp: Date.now() + 30 * 24 * 60 * 60 * 1000 })).toString("base64url");
  const sig = createHmac("sha256", SECRET()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

/** Constant-time string equality via HMAC digests (also masks length differences). */
function safeEqual(a, b) {
  const key = SECRET() || "cmp";
  const da = createHmac("sha256", key).update(String(a)).digest();
  const db = createHmac("sha256", key).update(String(b)).digest();
  return timingSafeEqual(da, db);
}

function checkCredentials(username, password) {
  const raw = process.env.AUTH_USERS ?? "";
  // No short-circuit: evaluate every pair so timing doesn't reveal which username exists.
  let ok = false;
  for (const pair of raw.split(",")) {
    const [u, p] = pair.trim().split(":");
    const match = safeEqual(u ?? "", username) & safeEqual(p ?? "", password);
    ok = ok || match === 1;
  }
  return ok;
}

// Best-effort per-IP throttle (in-memory, per warm container): 10 attempts / 5 min. A cold
// start resets it, so this is friction against dumb brute force, not a hard guarantee.
const attempts = new Map();
function throttled(ip) {
  const now = Date.now();
  const rec = attempts.get(ip) ?? { n: 0, since: now };
  if (now - rec.since > 5 * 60 * 1000) { rec.n = 0; rec.since = now; }
  rec.n += 1;
  attempts.set(ip, rec);
  return rec.n > 10;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization",
};

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: CORS, body: "" };

  const ip = event.headers["x-nf-client-connection-ip"] ?? event.headers["client-ip"] ?? "unknown";
  if (throttled(ip)) {
    return { statusCode: 429, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify({ error: "Too many attempts — wait a few minutes" }) };
  }

  let username, password;
  try { ({ username, password } = JSON.parse(event.body ?? "{}")); }
  catch { return { statusCode: 400, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  if (!SECRET()) return { statusCode: 500, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify({ error: "AUTH_SECRET not configured" }) };
  if (!username || !password || !checkCredentials(username, password)) {
    return { statusCode: 401, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify({ error: "Invalid credentials" }) };
  }

  return {
    statusCode: 200,
    headers: { ...CORS, "content-type": "application/json" },
    body: JSON.stringify({ token: makeToken(username), user: username }),
  };
};
