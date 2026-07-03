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
import { getStore } from "@netlify/blobs";
import { config } from "./config.js";
import { buildDashboard, writeDashboard, type DashboardData } from "./dashboard.js";
import type { Board, DetectedLevel } from "./types.js";

const NETLIFY_BIN = process.env.NETLIFY_BIN?.trim() || "netlify";

// Data JSONs are NOT shipped in the public deploy: a static file bypasses the login entirely
// (anyone can fetch /dashboard.json). They stay in web/ for LAN viewing (npm run web); the
// deployed site reads them through the token-checked functions (dashboard.mjs, narrative.mjs)
// backed by Netlify Blobs instead.
const PRIVATE_DATA_FILES = new Set(["dashboard.json", "narrative.json", "regime.json"]);

/** Copy web/ to a staging dir minus the private data JSONs — what actually gets deployed. */
async function stageWebDir(): Promise<string> {
  const src = path.join(config.paths.root, "web");
  const dst = path.join(config.paths.root, "data", "deploy-stage");
  await fs.rm(dst, { recursive: true, force: true });
  await fs.cp(src, dst, { recursive: true, filter: (s) => !PRIVATE_DATA_FILES.has(path.basename(s)) });
  return dst;
}

/**
 * Push the board to the Netlify Blobs "dashboard" store — the source the authed dashboard
 * function, the watchdog, and the regime engine read. Best-effort: requires NETLIFY_SITE_ID +
 * NETLIFY_AUTH_TOKEN in the local .env (same creds the backfill uses).
 */
async function pushDashboardBlob(data: DashboardData): Promise<void> {
  const siteID = process.env.NETLIFY_SITE_ID?.trim();
  const token = process.env.NETLIFY_AUTH_TOKEN?.trim();
  if (!siteID || !token) return;
  await getStore({ name: "dashboard", siteID, token }).setJSON("latest", data);
}

/** Deploy web/ as pre-built static files (no build step → no Netlify build minutes). */
export async function netlifyDeploy(): Promise<void> {
  const siteId = process.env.NETLIFY_SITE_ID?.trim();
  const stagedDir = await stageWebDir();
  // Run via a shell: on Windows the CLI is netlify.cmd, which Node can't spawn
  // directly (EINVAL) — shell:true resolves it through PATHEXT. Quote the dir for spaces.
  // --functions ships the live-spot service alongside the static web/ dir; without
  // it, deploying with --dir would drop the function and the spot would go stale too.
  const cmd = [
    NETLIFY_BIN, "deploy", "--prod",
    "--dir", `"${stagedDir}"`,
    "--functions", `"${path.join(config.paths.root, "netlify", "functions")}"`,
  ]
    .concat(siteId ? ["--site", siteId] : [])
    .join(" ");

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, { stdio: ["ignore", "pipe", "pipe"], env: process.env, shell: true });
    let err = "";
    child.stdout.on("data", (d) => process.stdout.write(d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) =>
      reject(new Error(`Could not launch "${NETLIFY_BIN}". Install it (npm i -g netlify-cli) and run \`netlify login\`. ${e.message}`)),
    );
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`netlify deploy exited ${code}: ${err.slice(0, 500)}`))));
  });
}

/** Build + write the dashboard JSON, push it to Blobs, then deploy if a target is configured. */
export async function publish(board: Board, detected: DetectedLevel[], session?: string | null): Promise<DashboardData> {
  const data = buildDashboard(board, detected, session);
  await writeDashboard(data);

  // The phone dashboard reads the board through the token-checked function backed by this
  // blob — the deploy no longer ships dashboard.json publicly. A blob failure must not stop
  // the deploy (the UI still has the cloud rule-board fallback).
  try {
    await pushDashboardBlob(data);
  } catch (err) {
    console.warn("dashboard Blobs push failed:", err instanceof Error ? err.message : err);
  }

  if (process.env.PUBLISH_TARGET?.trim() === "netlify") {
    await netlifyDeploy();
    console.log("  published → Netlify");
  } else {
    console.log("  dashboard → web/dashboard.json");
  }
  return data;
}

/** Deploy web/ (incl. narrative.json) when a target is configured — for the narrative pass. */
export async function deploySite(): Promise<void> {
  if (process.env.PUBLISH_TARGET?.trim() === "netlify") {
    await netlifyDeploy();
    console.log("  narrative → Netlify");
  } else {
    console.log("  narrative → web/narrative.json");
  }
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
