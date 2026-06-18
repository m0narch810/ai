import { config } from "./config.js";

/**
 * Altaris auth. The terminal gates `/api/*` behind an `altaris_session` cookie that
 * expires periodically. Rather than re-paste it by hand, we log in with stored
 * credentials (ALTARIS_USER/ALTARIS_PASS) and refresh the cookie on demand — this is
 * a plain username/password POST to /api/login, so it works locally and in the cloud.
 *
 * Precedence: use ALTARIS_COOKIE if provided; otherwise (or on a 401) log in. A bare
 * cookie still works with no credentials — auto-refresh just won't be available.
 */

const LOGIN_HEADERS = {
  accept: "application/json",
  "content-type": "application/json",
  referer: "https://altaris.up.railway.app/login",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
};

let currentCookie = config.cookie; // may be "" until first login
let pendingRefresh: Promise<string> | null = null; // single-flight guard

export function hasCredentials(): boolean {
  return Boolean(config.altarisUser && config.altarisPass);
}

export function getCookie(): string {
  return currentCookie;
}

/** Pull `altaris_session=<token>` out of one or more Set-Cookie headers. */
function extractSessionCookie(res: Response): string | null {
  // Node 18.14+/undici: getSetCookie() returns each Set-Cookie separately.
  const raw = typeof res.headers.getSetCookie === "function"
    ? res.headers.getSetCookie()
    : [res.headers.get("set-cookie") ?? ""];
  for (const line of raw) {
    const m = /(?:^|;\s*)altaris_session=([^;]+)/.exec(line);
    if (m?.[1]) return `altaris_session=${m[1]}`;
  }
  return null;
}

async function doLogin(): Promise<string> {
  if (!hasCredentials()) {
    throw new Error(
      "Altaris cookie missing/expired and no credentials to refresh it. " +
        "Set ALTARIS_USER and ALTARIS_PASS in .env (or paste a fresh ALTARIS_COOKIE).",
    );
  }
  const res = await fetch(config.loginUrl, {
    method: "POST",
    headers: LOGIN_HEADERS,
    body: JSON.stringify({ email: config.altarisUser, password: config.altarisPass }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Altaris login failed -> HTTP ${res.status}. ${body.slice(0, 200)}`);
  }
  const cookie = extractSessionCookie(res);
  if (!cookie) throw new Error("Altaris login succeeded but no altaris_session cookie was returned.");
  currentCookie = cookie;
  return cookie;
}

/** Log in (or reuse an in-flight login) and update the cached cookie. */
export function refreshCookie(): Promise<string> {
  if (!pendingRefresh) {
    pendingRefresh = doLogin().finally(() => { pendingRefresh = null; });
  }
  return pendingRefresh;
}
