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

  // Must mirror src/auth.ts exactly: Altaris expects { email, password } (NOT username),
  // and the same headers — otherwise the login is rejected.
  const LOGIN_HEADERS = {
    accept: "application/json",
    "content-type": "application/json",
    referer: "https://altaris.up.railway.app/login",
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
  };

  // Pull altaris_session out of one or more Set-Cookie headers (undici splits them).
  const extractCookie = (res) => {
    const raw = typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : [res.headers.get("set-cookie") ?? ""];
    for (const line of raw) {
      const m = /(?:^|;\s*)altaris_session=([^;]+)/.exec(line);
      if (m?.[1]) return `altaris_session=${m[1]}`;
    }
    return null;
  };

  try {
    const loginRes = await fetch(`${base}/login`, {
      method: "POST",
      headers: LOGIN_HEADERS,
      body: JSON.stringify({ email: user, password: pass }),
    });

    if (!loginRes.ok) {
      const body = await loginRes.text().catch(() => "");
      return new Response(JSON.stringify({ error: "Altaris login failed", status: loginRes.status, body: body.slice(0, 200) }), {
        status: 502,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    const cookie = extractCookie(loginRes);
    if (!cookie) {
      return new Response(JSON.stringify({ error: "Login ok but no altaris_session cookie returned" }), {
        status: 502,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    const candleRes = await fetch(`${base}/candles?days=1`, {
      headers: { accept: "application/json", "user-agent": LOGIN_HEADERS["user-agent"], Cookie: cookie },
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
