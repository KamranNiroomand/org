import { useEffect, useState } from 'react';

/**
 * A clock that re-renders on every tick.
 *
 * Anything showing elapsed time derives it from this rather than counting up
 * privately, so a tab that was asleep catches up on its first frame instead of
 * resuming from a stale total.
 *
 * When `enabled` is false no interval is created at all — a page with no timer
 * running costs nothing.
 */
export function useNow(intervalMs = 1000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs, enabled]);

  return now;
}
