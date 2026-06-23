import { getStore } from "@netlify/blobs";
import type { CaptureRecord, GreekTimeseries } from "./types.js";

/**
 * Reads the snapshots that `netlify/functions/capture.mjs` stored while the PC was off.
 *
 * The cloud function runs inside Netlify, where Blobs auth is ambient. From the PC we're an
 * outside client, so we connect in "manual" mode with a site ID + a personal access token:
 *   NETLIFY_SITE_ID     — Site settings → General → Site ID (API ID).
 *   NETLIFY_AUTH_TOKEN  — User settings → Applications → Personal access token.
 * Both go in the local .env (they never ship to the cloud — they're only for pulling down).
 */

export interface CloudTick {
  key: string;
  record: CaptureRecord;
  /** The cumulative greek timeseries as-of this tick (used to score the tick faithfully). */
  greek: GreekTimeseries | null;
}

function capturesStore() {
  const siteID = process.env.NETLIFY_SITE_ID?.trim();
  const token = process.env.NETLIFY_AUTH_TOKEN?.trim();
  if (!siteID || !token) {
    throw new Error(
      "Cloud backfill needs NETLIFY_SITE_ID + NETLIFY_AUTH_TOKEN in .env to read the captures store. " +
        "Site ID: Netlify → Site settings → General. Token: Netlify → User settings → Applications → New access token.",
    );
  }
  return getStore({ name: "captures", siteID, token });
}

/** All cloud-captured ticks for an ET date (e.g. "2026-06-22"), oldest first. */
export async function fetchCloudCaptures(date: string): Promise<CloudTick[]> {
  const store = capturesStore();
  const { blobs } = await store.list({ prefix: `${date}/` });
  const ticks = await Promise.all(
    blobs.map(async ({ key }) => {
      const v = (await store.get(key, { type: "json" })) as
        | { capturedAt: string; data: CaptureRecord["data"]; iv?: CaptureRecord["iv"]; greek?: GreekTimeseries }
        | null;
      if (!v) return null;
      return {
        key,
        record: { capturedAt: v.capturedAt, data: v.data, iv: v.iv } as CaptureRecord,
        greek: v.greek ?? null,
      } satisfies CloudTick;
    }),
  );
  return ticks
    .filter((t): t is CloudTick => t !== null)
    .sort((a, b) => a.record.capturedAt.localeCompare(b.record.capturedAt));
}
