// Serves the latest scored board from Netlify Blobs, behind the login token.
//
// Why this exists: dashboard.json used to be a static file in the deploy — which meant anyone
// could fetch it without logging in (the auth was decorative for the most sensitive data).
// The local publisher now pushes each board to the "dashboard" Blobs store and the deploy no
// longer ships the static file; this function is the only public read path, and it checks the
// same HMAC token as every other data endpoint.
import { connectLambda, getStore } from "@netlify/blobs";
import { createHmac, timingSafeEqual } from "node:crypto";

function verifyToken(authHeader) {
  const token = (authHeader ?? "").replace(/^Bearer\s+/, "");
  if (!token || !process.env.AUTH_SECRET) return false;
  const dot = token.lastIndexOf(".");
  if (dot < 0) return false;
  const payload = token.slice(0, dot), sig = token.slice(dot + 1);
  const expected = createHmac("sha256", process.env.AUTH_SECRET).update(payload).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  try { const { exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); return Number.isFinite(exp) && Date.now() < exp; }
  catch { return false; }
}

export const handler = async (event) => {
  if (!verifyToken(event.headers["authorization"] ?? event.headers["Authorization"])) {
    return { statusCode: 401, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "Unauthorized" }) };
  }
  connectLambda(event);
  try {
    const data = await getStore("dashboard").get("latest", { type: "json" });
    if (!data) return { statusCode: 404, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "no board yet — publishes on the next scoring tick" }) };
    return {
      statusCode: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store, max-age=0" },
      body: JSON.stringify(data),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("dashboard function error:", msg);
    return { statusCode: 500, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: msg }) };
  }
};
