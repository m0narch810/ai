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

export const handler = async (event) => {
  connectLambda(event);
  try {
    const data = await getStore("narrative").get("latest", { type: "json" });
    if (!data) return { statusCode: 404, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "no narrative yet — runs automatically before market open" }) };
    return {
      statusCode: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: JSON.stringify(data),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("narrative function error:", msg);
    return { statusCode: 500, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: msg }) };
  }
};
