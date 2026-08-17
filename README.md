# Org

A personal operating system — todos, projects, a dual Shamsi/Miladi calendar,
finances, investments, and ideas, in one local app.

Everything runs on your machine. The database is a single SQLite file at
`~/.org/org.db`, the server binds `127.0.0.1` only, and nothing is sent anywhere
except the API calls you explicitly configure (Plaid for banking, Yahoo for
quotes, Anthropic for the Ideas tab).

---

## Running it

```bash
npm install
npm run dev
```

Then open **http://localhost:5173**.

> Vite 8 binds IPv6 only, so `localhost` works but a literal `127.0.0.1:5173`
> does not. The API server is the other way round — it binds `127.0.0.1:5174`.
> In normal use you only ever visit the Vite URL; it proxies `/api` for you.

| Command | What it does |
|---|---|
| `npm run dev` | Both servers, with reload |
| `npm test` | Vitest across the workspace |
| `npm run typecheck` | `tsc -b` over all three packages |
| `npm run lint` | ESLint |
| `npm run build` | Production build of the web app |
| `npm run db:studio` | Drizzle Studio against `~/.org/org.db` |

---

## Layout

```
apps/web       React 19 + Vite + Tailwind v4   → :5173
apps/server    Fastify + SQLite + Drizzle       → :5174
packages/shared  Types, money, and the calendar core
```

`packages/shared` is imported by both sides, so a date or a transaction has
exactly one definition. It ships TypeScript source with no build step — Vite and
`tsx` compile it in place.

---

## Two rules the whole codebase follows

**Money is integer cents, never floats.** `$45.30` is `4530`. Floats lose
pennies when you sum a few hundred transactions, and a budget that disagrees
with its own ledger by a cent is worse than useless — you can't tell a rounding
artifact from a real bug.

**Instants are UTC ISO strings; civil days are `YYYY-MM-DD`.** A due date has no
time of day, so storing one invites off-by-one-day bugs across timezones. The
calendar grid runs entirely on civil dates, which is what stops a task due at
11pm rendering on tomorrow's square.

---

## The calendar

Shamsi (Persian) and Miladi (Gregorian) are both first-class. The sidebar toggle
changes which one *leads*; the other is always still on screen.

Conversion uses `jalaali-js` (Borkowski's algorithm). Its output is checked
against `Intl`'s own Persian calendar day-by-day across six years in the test
suite — the two agree exactly between Gregorian 1800 and 2256, and the test
fails loudly if that ever drifts.

Month navigation follows the leading calendar, so paging forward from Mordad
reaches Shahrivar rather than September. Iranian holidays that fall on fixed
Jalali dates are marked. Lunar Hijri holidays deliberately aren't — computing
them from a tabular calendar produces dates that are frequently a day off from
the ones actually observed, which is worse than showing nothing.

---

## Configuration

Copy `.env.example` to `.env`. Every key is optional — the app runs without any
of them, just with fewer features.

### Banking (Plaid)

Sign up at [dashboard.plaid.com](https://dashboard.plaid.com/signup) and apply
for the **Trial plan**: free, US/Canada, 10 live bank connections against real
production data, no approval queue. Personal use needs three to five, so it
stays free.

```
PLAID_ENV=sandbox        # flip to `production` once the pipeline is proven
PLAID_CLIENT_ID=...
PLAID_SECRET=...
```

Access tokens are AES-256-GCM encrypted before they touch the database, with the
key held in the macOS Keychain rather than on disk. `/api/health` reports
`features.encryption` so the UI can explain why connecting a bank is unavailable
instead of failing at the moment you try.

### Ideas (Anthropic)

```
ANTHROPIC_API_KEY=...
ANTHROPIC_MODEL=claude-opus-5
```

The key stays server-side; the browser calls a local proxy route.

### LAN access

The server binds `127.0.0.1` by default. To reach it from your phone:

```
BIND_LAN=true
APP_PASSWORD=something-long
```

Setting `BIND_LAN=true` without a password is a startup error, not a warning —
this database holds your bank transactions, and the two ship together or not at
all.

---

## What's built

| Area | State |
|---|---|
| Shell, sidebar, ⌘K palette, ⌘1–7 | Done |
| Dual calendar + 49 passing date tests | Done |
| Todo with natural-language quick add | Done |
| Projects with task rollups | Done |
| Finances: accounts, ledger, categories, budgets, charts | Done |
| Rules-based auto-categorizer that learns from corrections | Done |
| Investments: holdings, live quotes, BoC FX, allocation | Done |
| Ideas: editor + Claude expand / critique / relate / break down | Done |
| **Plaid Link + daily sync** | **Not built** — schema, crypto, and config are in place; the Link flow and `/transactions/sync` cursor loop are not |
| **CSV / OFX statement import** | **Not built** — `import_hash` column and dedupe design are in place; the parser and drop-zone are not |
| **Daily cron** | **Not built** — `SYNC_CRON` is parsed but nothing is scheduled yet |

The three unbuilt items are the automated-ingestion half of the finance tab.
Everything they'd feed — the ledger, the categorizer, budgets, the charts —
already works against manually entered and seeded data.

---

## Verifying it

```bash
npm test          # 69 tests
npm run typecheck # clean across all three packages
```

The tests worth knowing about:

- **Calendar** — Nowruz 1405 = 2026-03-21; 2026-08-17 = 26 Mordad 1405; every
  day round-trips across four years; a 33-year leap cycle gives every year 365
  or 366 days; the grid is always 6×7 with no gaps or repeats.
- **Money** — `splitMoney` always sums back to the original; 1000 tests of
  parse-format round-tripping; mixed-currency sums throw rather than silently
  producing a wrong number.
- **Quick add** — `pay hydro bill friday !high #home` parses into all four
  fields; "monday" on a Monday means *next* Monday; unrecognized words stay in
  the title.

The portfolio math was also checked by hand against the live Bank of Canada
rate: a USD holding and a CAD holding convert to a cost basis that matches the
manual calculation to the cent.
