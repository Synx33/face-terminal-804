// Scheduling only -- "when do we run" -- not "what do we do when we run".
// What actually happens on each run (sync employees, fetch events, insert
// check-ins) is wired up by server.js and handed in as `runFn`, the same
// split poller.js already used between "when" (startPolling) and "what"
// (the onNewCheckin/onPollError callbacks it's given).
//
// Why a scheduled batch pull instead of continuous polling at all for this
// device: see db.js's getExtractHour() comment. Short version -- this
// model's embedded web server has repeatedly shown it can't reliably
// handle frequent digest-auth traffic, confirmed live more than once
// (including two separate, non-overlapping processes politely taking
// turns still tripping its account lock). One request window a day instead
// of one every couple seconds removes that whole failure class rather than
// trying to tune retry/backoff constants against it forever. Trade-off
// made deliberately: check-ins only show up after the nightly run, not
// live through the day -- fine for attendance/payroll, not for live
// monitoring.

const logger = require('./logger');

const GEORGIA_OFFSET_HOURS = 4;

// How stale the last successful run has to be before boot treats it as
// "we missed the scheduled window" and runs a catch-up immediately instead
// of waiting up to 24h for the next one. 25h (not 24h) so a run that's
// simply running a little late on its own schedule doesn't also get
// double-triggered by this check.
const MISSED_RUN_THRESHOLD_MS = 25 * 3600_000;

/** ms from now until the next occurrence of `hour`:00 Georgia-local time. */
function msUntilNextHour(hour) {
  const now = new Date();
  const nowGeorgia = new Date(now.getTime() + GEORGIA_OFFSET_HOURS * 3600_000);
  const next = new Date(nowGeorgia);
  next.setUTCHours(hour, 0, 0, 0);
  if (next <= nowGeorgia) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - nowGeorgia.getTime();
}

/**
 * @param {() => number|null} getLastRunAt - ms since epoch of the last
 *   successful run, or null if it's never run (drives the boot catch-up
 *   decision below).
 * @param {() => number} getHour - 0-23, read fresh on every reschedule so a
 *   Settings change takes effect on the very next cycle, no restart needed.
 * @param {() => Promise<void>} runFn
 * @returns {{ stop: () => void, runNow: () => Promise<void> }}
 */
function scheduleDailyExtraction({ getLastRunAt, getHour, runFn }) {
  let timer = null;
  let running = false;

  // Logs and RE-THROWS on failure -- the manual "run now" API route needs
  // the real error to report back to whoever clicked the button, instead of
  // a silent always-ok response. The two automatic callers below (the
  // scheduled timer and the boot catch-up) each swallow it themselves after
  // this already logged it, same end result for them as before.
  async function runNow() {
    // A manual "run now" click racing the scheduled firing (or two manual
    // clicks in a row) must never overlap -- same reasoning as the old
    // poller's inFlight guard, just at once-a-day instead of every-1.5s
    // scale where it'd be easy to assume "that can't happen" and be wrong.
    if (running) {
      logger.log('[extract] already running, ignoring overlapping trigger');
      return;
    }
    running = true;
    try {
      await runFn();
    } catch (err) {
      logger.error('[extract] run failed:', err.message);
      throw err;
    } finally {
      running = false;
    }
  }

  function scheduleNext() {
    const delay = msUntilNextHour(getHour());
    timer = setTimeout(async () => {
      await runNow().catch(() => {}); // already logged inside runNow
      scheduleNext();
    }, delay);
    logger.log(`[extract] next run in ${Math.round(delay / 60_000)} min (${getHour()}:00 Georgia time)`);
  }

  (async () => {
    const lastRunAt = getLastRunAt();
    const missedLastRun = !lastRunAt || (Date.now() - lastRunAt) > MISSED_RUN_THRESHOLD_MS;
    if (missedLastRun) {
      logger.log('[extract] no recent run on record — running a catch-up extraction now');
      await runNow().catch(() => {}); // already logged inside runNow
    }
    scheduleNext();
  })();

  return { stop: () => clearTimeout(timer), runNow };
}

module.exports = { scheduleDailyExtraction, msUntilNextHour };
