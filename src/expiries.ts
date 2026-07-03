// Deterministic CBOE expiration calendar — computed by rule, not scraped.
//
// Why it matters (the EVENT CHOP prior in the scorer): the session before and of the VIX
// monthly settlement tends to chop as vol positioning unwinds — a structurally clean level
// is a lower-probability blind fade on those days. Monthly OPEX (3rd Friday) amplifies
// charm/pinning; quad witching (Mar/Jun/Sep/Dec OPEX) adds index futures/options unwinds.
//
// Rules (no calendar feed needed):
//   - Monthly OPEX          = 3rd Friday of the month (prior business day if a holiday).
//   - VIX monthly settlement = 30 calendar days BEFORE the following month's SPX 3rd-Friday
//     expiry — normally a Wednesday, settled on the OPEN (AM settlement).
//   - Quad witching         = the Mar/Jun/Sep/Dec OPEX.
// VIX weeklys expire most other Wednesdays too, but the monthly is the one that moves the
// tape — only the monthly is flagged here.
import { US_MARKET_HOLIDAYS } from "./config.js";

const DAY_MS = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

function thirdFriday(year: number, month0: number): Date {
  const first = new Date(Date.UTC(year, month0, 1));
  const firstFriday = 1 + ((5 - first.getUTCDay() + 7) % 7);
  return new Date(Date.UTC(year, month0, firstFriday + 14));
}

/** Step back to the prior business day while landing on a weekend/exchange holiday. */
function businessDayOnOrBefore(d: Date): Date {
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6 || US_MARKET_HOLIDAYS.has(iso(d))) {
    d = new Date(d.getTime() - DAY_MS);
  }
  return d;
}

export interface ExpiryContext {
  /** Next (or today's) VIX monthly AM settlement date, ET. */
  vix_settlement: string;
  /** Calendar days until it. 0 = settles THIS morning; 1 = tomorrow (chop-prone session). */
  days_to_vix_settlement: number;
  /** Wednesday VIX weekly expiry (much smaller OI than the monthly — a mild note, not a gate). */
  vix_weekly_expiry_today: boolean;
  /** Next (or today's) monthly OPEX (3rd Friday, holiday-adjusted). */
  monthly_opex: string;
  days_to_monthly_opex: number;
  /** Days since the LAST monthly OPEX (1-2 = OI still rebuilding, walls may be stale). */
  days_since_monthly_opex: number;
  /** True when the upcoming OPEX is quad witching (Mar/Jun/Sep/Dec). */
  quad_witching_opex: boolean;
}

/** Expiry calendar context for an ET date ("YYYY-MM-DD..." — extra characters ignored). */
export function expiryContext(dateIso: string): ExpiryContext | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateIso);
  if (!m) return null;
  const today = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const y = today.getUTCFullYear(), mo = today.getUTCMonth();

  // Next monthly OPEX on/after today, and the most recent one before it.
  const thisMonthOpex = businessDayOnOrBefore(thirdFriday(y, mo));
  let opex = thisMonthOpex;
  let prevOpex: Date;
  if (opex < today) {
    prevOpex = thisMonthOpex;
    opex = businessDayOnOrBefore(thirdFriday(mo === 11 ? y + 1 : y, (mo + 1) % 12));
  } else {
    prevOpex = businessDayOnOrBefore(thirdFriday(mo === 0 ? y - 1 : y, (mo + 11) % 12));
  }

  // Next VIX monthly settlement on/after today: derived from following months' SPX expiries.
  let vix: Date | null = null;
  for (let k = 1; k <= 3 && !vix; k++) {
    const mm = mo + k;
    const spx = businessDayOnOrBefore(thirdFriday(y + Math.floor(mm / 12), mm % 12));
    const cand = new Date(spx.getTime() - 30 * DAY_MS);
    if (cand >= today) vix = cand;
  }
  if (!vix) return null; // unreachable in practice

  const daysTo = (d: Date) => Math.round((d.getTime() - today.getTime()) / DAY_MS);
  return {
    vix_settlement: iso(vix),
    days_to_vix_settlement: daysTo(vix),
    vix_weekly_expiry_today: today.getUTCDay() === 3 && daysTo(vix) !== 0,
    monthly_opex: iso(opex),
    days_to_monthly_opex: daysTo(opex),
    days_since_monthly_opex: -daysTo(prevOpex),
    quad_witching_opex: [2, 5, 8, 11].includes(opex.getUTCMonth()),
  };
}
