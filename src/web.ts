// Tiny static server for the dashboard — serves web/ on the LAN so you can open
// the board on your phone while the box is on (the hybrid model). No deps.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { config } from "./config.js";

const WEB_DIR = path.join(config.paths.root, "web");
const PORT = Number(process.env.WEB_PORT || 8787);
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const server = createServer(async (req, res) => {
  const rel = decodeURIComponent((req.url || "/").split("?")[0] ?? "/");
  const name = rel === "/" ? "index.html" : rel.replace(/^\/+/, "");
  const file = path.join(WEB_DIR, name);

  // Confine to web/ — no path traversal.
  if (!file.startsWith(WEB_DIR)) { res.writeHead(403).end("forbidden"); return; }

  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }
});

function lanUrls(): string[] {
  const urls: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === "IPv4" && !a.internal) urls.push(`http://${a.address}:${PORT}`);
  }
  return urls;
}

server.listen(PORT, () => {
  console.log(`Dashboard server on:`);
  console.log(`  http://localhost:${PORT}`);
  for (const u of lanUrls()) console.log(`  ${u}   ← open this on your phone (same Wi-Fi)`);
});
