import { and, eq, inArray } from 'drizzle-orm';
import ical from 'node-ical';
import type { CalendarComponent } from 'node-ical';
import { decrypt } from '../crypto.js';
import { db } from '../db/index.js';
import { calendarFeeds, events } from '../db/schema.js';
import { newId, nowIso } from './util.js';

/**
 * Subscribed calendar ingestion.
 *
 * Google and Outlook both publish a calendar as a live iCalendar URL. Fetching
 * one returns the calendar as it stands — no OAuth app, no consent screen, and
 * nothing for the user to download. The cost is freshness: Google in
 * particular serves outside subscribers a cached copy that can lag by hours.
 *
 * A feed is the source of truth for its own events and nothing else. Each sync
 * replaces that feed's events wholesale, keyed by iCalendar UID, so an event
 * deleted upstream disappears here too. Events created by hand in Org have a
 * null `feedId` and are never touched.
 */

/**
 * How far to expand recurring events around today. A weekly standup has no end
 * date, so something has to bound it; a year back and two forward covers every
 * view the calendar offers without materialising an infinite series.
 */
const PAST_WINDOW_DAYS = 365;
const FUTURE_WINDOW_DAYS = 730;

const MS_PER_DAY = 86_400_000;

export interface FeedSyncOutcome {
  feedId: string;
  name: string;
  added: number;
  updated: number;
  removed: number;
  error: string | null;
}

interface ParsedEvent {
  uid: string;
  title: string;
  notes: string | null;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  location: string | null;
}

/** An all-day VEVENT arrives with a date-only DTSTART and no meaningful time. */
function isAllDay(component: CalendarComponent): boolean {
  const start = (component as { start?: Date & { dateOnly?: boolean } }).start;
  return start?.dateOnly === true;
}

const iso = (d: Date): string => new Date(d).toISOString();

/**
 * Expands one VEVENT into the concrete occurrences that fall inside the
 * window. A non-recurring event yields itself; a recurring one yields one
 * entry per occurrence, each with its own UID suffix so the upsert can tell
 * them apart.
 */
function expand(component: CalendarComponent, from: Date, to: Date): ParsedEvent[] {
  const c = component as CalendarComponent & {
    uid?: string;
    summary?: string;
    description?: string;
    location?: string;
    start?: Date;
    end?: Date;
    rrule?: { between: (a: Date, b: Date, inc?: boolean) => Date[] };
    recurrences?: Record<string, CalendarComponent>;
    exdate?: Record<string, Date>;
  };

  if (!c.uid || !c.start) return [];

  const title = (c.summary ?? '').trim() || '(untitled)';
  const notes = c.description?.trim() || null;
  const location = c.location?.trim() || null;
  const allDay = isAllDay(component);

  // An event with no DTEND is a point in time; iCalendar treats it as zero
  // length, and so does the calendar UI once start and end match.
  const durationMs = c.end ? new Date(c.end).getTime() - new Date(c.start).getTime() : 0;

  const base = (start: Date, uidSuffix?: string): ParsedEvent => ({
    uid: uidSuffix ? `${c.uid}::${uidSuffix}` : c.uid!,
    title,
    notes,
    startsAt: iso(start),
    endsAt: iso(new Date(new Date(start).getTime() + durationMs)),
    allDay,
    location,
  });

  if (!c.rrule) {
    const start = new Date(c.start);
    return start >= from && start <= to ? [base(start)] : [];
  }

  // Dates the series explicitly skips, and dates whose occurrence was edited
  // individually — the override carries its own times and is emitted instead.
  const excluded = new Set(Object.keys(c.exdate ?? {}));
  const overrides = c.recurrences ?? {};

  const out: ParsedEvent[] = [];
  for (const occurrence of c.rrule.between(from, to, true)) {
    const key = iso(occurrence).slice(0, 10);
    if (excluded.has(key)) continue;

    const override = overrides[key] as (CalendarComponent & { start?: Date; summary?: string }) | undefined;
    if (override?.start) {
      const o = base(new Date(override.start), iso(occurrence));
      out.push({ ...o, title: (override.summary ?? title).trim() || title });
    } else {
      out.push(base(occurrence, iso(occurrence)));
    }
  }
  return out;
}

/** Fetches and parses a feed. Network and parse failures surface as errors. */
async function fetchFeed(url: string): Promise<ParsedEvent[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  let text: string;
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'text/calendar, text/plain;q=0.9' },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`Feed returned HTTP ${res.status}`);
    text = await res.text();
  } finally {
    clearTimeout(timeout);
  }

  // A wrong URL usually returns an HTML sign-in page with a 200, which would
  // otherwise parse to zero events and look like an empty calendar.
  if (!text.includes('BEGIN:VCALENDAR')) {
    throw new Error('That URL did not return a calendar — check it is the iCal/ICS address');
  }

  const parsed = await ical.async.parseICS(text);
  const now = Date.now();
  const from = new Date(now - PAST_WINDOW_DAYS * MS_PER_DAY);
  const to = new Date(now + FUTURE_WINDOW_DAYS * MS_PER_DAY);

  const out: ParsedEvent[] = [];
  for (const component of Object.values(parsed)) {
    // The parsed map also carries VTIMEZONE and VALARM entries; only VEVENTs
    // become events, and the narrowing is by tag rather than by type.
    if ((component as { type?: string }).type !== 'VEVENT') continue;
    out.push(...expand(component as CalendarComponent, from, to));
  }

  // A feed can legitimately repeat a UID across expansion edge cases; last
  // one wins rather than letting the unique index reject the whole batch.
  return [...new Map(out.map((e) => [e.uid, e])).values()];
}

/** Syncs one feed to completion. Never throws — failures land on the row. */
export async function syncFeed(feedId: string): Promise<FeedSyncOutcome> {
  const feed = db.select().from(calendarFeeds).where(eq(calendarFeeds.id, feedId)).get();
  if (!feed) throw new Error(`No such calendar feed: ${feedId}`);

  const outcome: FeedSyncOutcome = {
    feedId,
    name: feed.name,
    added: 0,
    updated: 0,
    removed: 0,
    error: null,
  };

  let incoming: ParsedEvent[];
  try {
    incoming = await fetchFeed(decrypt(feed.urlEnc));
  } catch (err) {
    outcome.error = err instanceof Error ? err.message : String(err);
    db.update(calendarFeeds)
      .set({ status: 'error', error: outcome.error })
      .where(eq(calendarFeeds.id, feedId))
      .run();
    return outcome;
  }

  /**
   * `external_uid` is nullable in the schema because hand-made events have no
   * upstream id, but every row belonging to a feed has one. Narrowing here
   * keeps the rest of the function honest about that.
   */
  const existing = db
    .select({ id: events.id, uid: events.externalUid })
    .from(events)
    .where(eq(events.feedId, feedId))
    .all()
    .filter((e): e is { id: string; uid: string } => e.uid !== null);
  const byUid = new Map(existing.map((e) => [e.uid, e.id]));

  db.transaction((tx) => {
    for (const e of incoming) {
      const shared = {
        title: e.title,
        notes: e.notes,
        startsAt: e.startsAt,
        endsAt: e.endsAt,
        allDay: e.allDay,
        location: e.location,
        color: feed.color,
        updatedAt: nowIso(),
      };

      const id = byUid.get(e.uid);
      if (id) {
        tx.update(events).set(shared).where(eq(events.id, id)).run();
        outcome.updated++;
      } else {
        tx.insert(events)
          .values({ id: newId(), feedId, externalUid: e.uid, createdAt: nowIso(), ...shared })
          .run();
        outcome.added++;
      }
    }

    // Anything this feed used to carry and no longer does was deleted upstream.
    const seen = new Set(incoming.map((e) => e.uid));
    const stale = existing.filter((e) => !seen.has(e.uid)).map((e) => e.id);
    if (stale.length > 0) {
      tx.delete(events).where(inArray(events.id, stale)).run();
      outcome.removed = stale.length;
    }

    tx.update(calendarFeeds)
      .set({ status: 'ok', error: null, lastSyncAt: nowIso() })
      .where(eq(calendarFeeds.id, feedId))
      .run();
  });

  return outcome;
}

/** Syncs every feed. Errors are collected, never thrown. */
export async function syncAllFeeds(): Promise<FeedSyncOutcome[]> {
  const feeds = db.select({ id: calendarFeeds.id }).from(calendarFeeds).all();
  const results: FeedSyncOutcome[] = [];
  for (const feed of feeds) {
    results.push(await syncFeed(feed.id));
  }
  return results;
}

/** Counts a feed's events, for the management UI. */
export function feedEventCount(feedId: string): number {
  return db.select({ id: events.id }).from(events).where(and(eq(events.feedId, feedId))).all().length;
}
