// Server-side proxy for Altaris candle data — credentials never reach the browser.
// Logs in with ALTARIS_USER/ALTARIS_PASS, fetches /api/candles?days=1, returns JSON.
export default async function handler(req, context) {
  const base = (process.env.ALTARIS_BASE_URL || "https://altaris.up.railway.app/api").replace(/\/$/, "");
  const user = process.env.ALTARIS_USER;
  const pass = process.env.ALTARIS_PASS;

  if (!user || !pass) {
    return new Response(JSON.stringify({ error: "Altaris credentials not configured" }), {
      status: 503,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  try {
    const loginRes = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: user, password: pass }),
    });

    if (!loginRes.ok) {
      return new Response(JSON.stringify({ error: "Altaris login failed", status: loginRes.status }), {
        status: 502,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    const setCookie = loginRes.headers.get("set-cookie") || "";
    const cookieMatch = setCookie.match(/altaris_session=([^;]+)/);
    const cookie = cookieMatch ? `altaris_session=${cookieMatch[1]}` : setCookie.split(";")[0];

    const candleRes = await fetch(`${base}/candles?days=1`, {
      headers: { Cookie: cookie },
    });

    if (!candleRes.ok) {
      return new Response(JSON.stringify({ error: "Candle fetch failed", status: candleRes.status }), {
        status: candleRes.status,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    const data = await candleRes.json();
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
}

export const config = { path: "/.netlify/functions/altaris-candles" };
