// Publishes the dashboard for the hybrid model: scoring stays local (Max plan),
// the board auto-publishes to a static site you can open on your phone.
//
// Two steps, the second optional:
//   1. write web/dashboard.json   (always)
//   2. `netlify deploy` the web/  (only when PUBLISH_TARGET=netlify)
//
// With PUBLISH_TARGET unset you still get a fresh web/dashboard.json — serve it
// over your LAN with `npm run web` and open it on your phone while the box is on.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { buildDashboard, writeDashboard, type DashboardData } from "./dashboard.js";
import type { Board, DetectedLevel } from "./types.js";

const NETLIFY_BIN = process.env.NETLIFY_BIN?.trim() || (process.platform === "win32" ? "netlify.cmd" : "netlify");

/** Deploy web/ as pre-built static files (no build step → no Netlify build minutes). */
function netlifyDeploy(): Promise<void> {
  const siteId = process.env.NETLIFY_SITE_ID?.trim();
  const args = ["deploy", "--prod", "--dir", path.join(config.paths.root, "web")];
  if (siteId) args.push("--site", siteId);

  return new Promise((resolve, reject) => {
    const child = spawn(NETLIFY_BIN, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let err = "";
    child.stdout.on("data", (d) => process.stdout.write(d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) =>
      reject(new Error(`Could not launch "${NETLIFY_BIN}". Install it (npm i -g netlify-cli) and run \`netlify login\`. ${e.message}`)),
    );
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`netlify deploy exited ${code}: ${err.slice(0, 500)}`))));
  });
}

/** Build + write the dashboard JSON, then deploy if a target is configured. */
export async function publish(board: Board, detected: DetectedLevel[], session?: string | null): Promise<DashboardData> {
  const data = buildDashboard(board, detected, session);
  await writeDashboard(data);

  if (process.env.PUBLISH_TARGET?.trim() === "netlify") {
    await netlifyDeploy();
    console.log("  published → Netlify");
  } else {
    console.log("  dashboard → web/dashboard.json");
  }
  return data;
}

/** Standalone: re-publish from the last persisted board + calibration (no re-scoring). */
async function fromDisk(): Promise<void> {
  const board = JSON.parse(await fs.readFile(path.join(config.paths.scored, "latest.json"), "utf8")) as Board;
  const date = board.as_of.slice(0, 10);
  const detected = await lastCalibration(date);
  await publish(board, detected);
}

/** The detector outcomes from the most recent calibration line for a date. */
async function lastCalibration(date: string): Promise<DetectedLevel[]> {
  try {
    const file = path.join(config.paths.scored, `${date}.calibration.jsonl`);
    const lines = (await fs.readFile(file, "utf8")).trim().split("\n").filter(Boolean);
    const last = lines.at(-1);
    if (!last) return [];
    return (JSON.parse(last) as { detected: DetectedLevel[] }).detected ?? [];
  } catch {
    return [];
  }
}

// `npm run publish` → re-publish the latest board without re-scoring.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  fromDisk().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
