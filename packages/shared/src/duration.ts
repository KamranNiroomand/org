/**
 * Task time, in two units that never mix.
 *
 * An **estimate** is whole minutes — nobody plans work to the second, and
 * storing it finer invites a UI that shows `1h 30m 00s`. **Tracked** time is
 * seconds, because a timer you just started has to visibly move; a minutes-only
 * counter sits on `0m` for a minute and reads as broken.
 *
 * Elapsed time is always *derived* from a stored start instant, never counted
 * up in the browser. A tab that was asleep, a page that was reloaded, and a
 * server that was restarted must all agree, and they only can if nobody is
 * keeping a private tally.
 */

import { toLatinDigits } from './money.js';

/**
 * Parses a typed duration into minutes. Accepts `"30"`, `"30m"`, `"2h"`,
 * `"1h30"`, `"1h 30m"`, `"1.5h"`, `"90 min"`, and Persian/Arabic-Indic digits.
 * A bare number means minutes, which is what people type most.
 *
 * Returns `null` rather than throwing, mirroring `parseMoney` — this runs on
 * every keystroke and a half-typed duration is not an error.
 */
export function parseDuration(input: string): number | null {
  if (typeof input !== 'string') return null;

  const s = toLatinDigits(input).trim().toLowerCase();
  if (s === '') return null;

  // "1h30", "1h 30m", "2h", "1.5h" — hours with an optional minute tail.
  const hm = /^(\d+(?:[.,]\d+)?)\s*(?:h|hr|hrs|hour|hours|س)\s*(?:(\d+)\s*(?:m|min|mins|minute|minutes|د)?)?$/.exec(s);
  if (hm) {
    const hours = Number(hm[1]!.replace(',', '.'));
    const mins = hm[2] === undefined ? 0 : Number(hm[2]);
    if (!Number.isFinite(hours) || !Number.isFinite(mins)) return null;
    return Math.round(hours * 60 + mins);
  }

  // "30", "30m", "90 min"
  const m = /^(\d+(?:[.,]\d+)?)\s*(?:m|min|mins|minute|minutes|د)?$/.exec(s);
  if (m) {
    const mins = Number(m[1]!.replace(',', '.'));
    return Number.isFinite(mins) ? Math.round(mins) : null;
  }

  return null;
}

/** Minutes → `"45m"`, `"1h 30m"`, `"2h"`. */
export function formatDuration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/**
 * Seconds → `"12s"` under a minute, `"45m"` under an hour, `"2h 05m"` above.
 *
 * The sub-minute band exists so a freshly started timer is visibly alive; the
 * zero-padded minutes above an hour keep the string from changing width as it
 * ticks past `2h 09m`.
 */
export function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) return `${total}s`;
  const mins = Math.floor(total / 60);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

/**
 * Total time on a task: what has been banked, plus the interval that is still
 * running. The single place elapsed time is computed — `now` is a parameter so
 * this stays pure and the caller controls the tick.
 */
export function elapsedSeconds(
  trackedSeconds: number,
  timerStartedAt: string | null,
  now: number = Date.now(),
): number {
  const banked = Math.max(0, Math.floor(trackedSeconds));
  if (!timerStartedAt) return banked;

  const started = Date.parse(timerStartedAt);
  if (Number.isNaN(started)) return banked;

  // Clamped at zero: the browser and the server are the same machine here, but
  // a clock adjustment mid-interval shouldn't make time run backwards on screen.
  return banked + Math.max(0, Math.floor((now - started) / 1000));
}
