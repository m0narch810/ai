// Serves the latest pre-open narrative from Netlify Blobs.
//
// Why this exists: web/narrative.json is a static file baked into each Netlify deploy — it only
// updates when the local scoring box runs `npm run narrative` and then redeploys. If the box was
// off overnight, the narrative stales out and the UI shows yesterday's open-type read.
//
// This function reads whatever the local narrativeTick() last pushed to Blobs (via NETLIFY_SITE_ID
// + NETLIFY_AUTH_TOKEN in the local .env). The browser now fetches from here instead of the static
// file, so the narrative stays live independently of deploy cadence.
//
// Fallback: if Blobs are empty (first deploy, before any narrative has run), the function returns
// 404 and the UI shows the "No narrative yet" placeholder, same as before.
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
    const data = await getStore("narrative").get("latest", { type: "json" });
    if (!data) return { statusCode: 404, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "no narrative yet — runs automatically before market open" }) };
    // Flag yesterday's narrative so the UI can badge it instead of presenting it as today's read.
    const etDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
    const stale = typeof data.as_of === "string" && !data.as_of.startsWith(etDate);
    return {
      statusCode: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: JSON.stringify({ ...data, stale }),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("narrative function error:", msg);
    return { statusCode: 500, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: msg }) };
  }
};
