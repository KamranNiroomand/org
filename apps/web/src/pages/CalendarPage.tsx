import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  buildMonthGrid,
  civilKey,
  civilToJalali,
  dayNumber,
  jalaliHoliday,
  monthLabel,
  monthOf,
  shiftMonth,
  todayCivil,
  weekdayLabels,
  type CivilDate,
} from '@org/shared';
import { Page, PageHeader } from '../components/PageHeader';
import { Badge, Button, Card, cn } from '../components/ui';
import { api } from '../lib/api';
import { useSettings } from '../lib/settings';

interface CalendarData {
  events: Array<{
    id: string;
    title: string;
    startsAt: string;
    endsAt: string;
    allDay: boolean;
    color: string;
  }>;
  tasks: Array<{
    id: string;
    title: string;
    dueOn: string;
    status: string;
    priority: string;
  }>;
}

export function CalendarPage() {
  const { calendar, persianDigits } = useSettings();
  const today = todayCivil();

  // The cursor is stored in the *leading* calendar's terms, so paging moves
  // Farvardin → Ordibehesht under Shamsi and January → February under Miladi.
  const [cursor, setCursor] = useState(() => monthOf(today, calendar));

  // Switching calendar systems mid-view would otherwise leave the cursor
  // holding a year like 1405 while rendering Gregorian months.
  const [lastSystem, setLastSystem] = useState(calendar);
  if (lastSystem !== calendar) {
    setLastSystem(calendar);
    setCursor(monthOf(today, calendar));
  }

  const grid = useMemo(
    () => buildMonthGrid(calendar, cursor.year, cursor.month, today),
    [calendar, cursor, today],
  );

  const range = useMemo(() => {
    const cells = grid.weeks.flat();
    return { from: cells[0]!.key, to: cells[cells.length - 1]!.key };
  }, [grid]);

  const { data } = useQuery({
    queryKey: ['calendar', range.from, range.to],
    queryFn: () => api.get<CalendarData>(`/api/calendar?from=${range.from}&to=${range.to}`),
  });

  const byDay = useMemo(() => {
    const map = new Map<string, { events: CalendarData['events']; tasks: CalendarData['tasks'] }>();
    const ensure = (k: string) => {
      let e = map.get(k);
      if (!e) map.set(k, (e = { events: [], tasks: [] }));
      return e;
    };

    for (const ev of data?.events ?? []) {
      // Bucket by the local civil day the event starts on, matching how the
      // grid itself is built.
      ensure(new Date(ev.startsAt).toLocaleDateString('en-CA')).events.push(ev);
    }
    for (const t of data?.tasks ?? []) ensure(t.dueOn).tasks.push(t);
    return map;
  }, [data]);

  const labels = weekdayLabels(calendar, persianDigits);
  const [selected, setSelected] = useState<CivilDate | null>(null);
  const selectedKey = selected ? civilKey(selected) : null;
  const selectedDay = selectedKey ? byDay.get(selectedKey) : undefined;

  return (
    <>
      <PageHeader
        title="Calendar"
        subtitle={
          calendar === 'shamsi'
            ? monthLabel(cursor.year, cursor.month, 'miladi')
            : monthLabel(civilToJalali(grid.weeks[2]![3]!.gregorian).jy, civilToJalali(grid.weeks[2]![3]!.gregorian).jm, 'shamsi', persianDigits)
        }
        actions={
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setCursor(shiftMonth(calendar, cursor.year, cursor.month, -1))}
              aria-label="Previous month"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setCursor(monthOf(today, calendar))}>
              Today
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setCursor(shiftMonth(calendar, cursor.year, cursor.month, 1))}
              aria-label="Next month"
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        }
      />

      <Page>
        <div className="mb-3 flex items-baseline gap-3">
          <h2
            className={cn(
              'text-xl font-semibold tracking-tight',
              calendar === 'shamsi' && persianDigits && 'fa',
            )}
            dir={calendar === 'shamsi' && persianDigits ? 'rtl' : 'ltr'}
          >
            {monthLabel(cursor.year, cursor.month, calendar, persianDigits)}
          </h2>
        </div>

        <Card className="overflow-hidden">
          <div className="grid grid-cols-7 border-b border-border bg-bg-subtle">
            {labels.map((l) => (
              <div
                key={l}
                className={cn(
                  'px-2 py-2 text-center text-[11px] font-medium text-muted',
                  calendar === 'shamsi' && persianDigits && 'fa',
                )}
              >
                {l}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-7">
            {grid.weeks.flat().map((cell) => {
              const day = byDay.get(cell.key);
              const holiday = jalaliHoliday(cell.jalali);
              const count = (day?.events.length ?? 0) + (day?.tasks.length ?? 0);

              return (
                <button
                  key={cell.key}
                  onClick={() => setSelected(cell.gregorian)}
                  className={cn(
                    'relative min-h-[86px] border-r border-b border-border p-1.5 text-left transition-colors last:border-r-0',
                    !cell.inMonth && 'bg-bg-subtle/50',
                    cell.isWeekend && cell.inMonth && 'bg-bg-subtle/40',
                    selectedKey === cell.key && 'ring-2 ring-accent ring-inset',
                    'hover:bg-accent-soft/40',
                  )}
                >
                  <div className="flex items-baseline justify-between gap-1">
                    <span
                      className={cn(
                        'tnum inline-flex size-[22px] items-center justify-center rounded-full text-xs',
                        cell.isToday && 'bg-accent font-semibold text-white',
                        !cell.isToday && !cell.inMonth && 'text-faint',
                        !cell.isToday && cell.inMonth && holiday?.official && 'text-negative',
                        calendar === 'shamsi' && persianDigits && 'fa',
                      )}
                    >
                      {dayNumber(cell.gregorian, calendar, persianDigits)}
                    </span>

                    {/* The non-leading calendar's day number, always visible —
                        it's the whole reason for a dual calendar. */}
                    <span
                      className={cn(
                        'tnum text-[10px] text-faint',
                        calendar === 'miladi' && persianDigits && 'fa',
                      )}
                    >
                      {dayNumber(
                        cell.gregorian,
                        calendar === 'shamsi' ? 'miladi' : 'shamsi',
                        persianDigits,
                      )}
                    </span>
                  </div>

                  {holiday && cell.inMonth && (
                    <div
                      className={cn(
                        'mt-0.5 truncate text-[9px]',
                        holiday.official ? 'text-negative' : 'text-faint',
                      )}
                      title={holiday.name}
                    >
                      {persianDigits ? holiday.nameFa : holiday.name}
                    </div>
                  )}

                  <div className="mt-1 space-y-0.5">
                    {day?.events.slice(0, 2).map((e) => (
                      <div
                        key={e.id}
                        className="truncate rounded bg-accent-soft px-1 py-px text-[10px] text-accent"
                      >
                        {e.title}
                      </div>
                    ))}
                    {day?.tasks.slice(0, 2).map((t) => (
                      <div
                        key={t.id}
                        className={cn(
                          'flex items-center gap-1 truncate text-[10px]',
                          t.status === 'done' ? 'text-faint line-through' : 'text-muted',
                        )}
                      >
                        <span className="size-1 shrink-0 rounded-full bg-current" />
                        {t.title}
                      </div>
                    ))}
                    {count > 4 && (
                      <div className="text-[10px] text-faint">+{count - 4} more</div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </Card>

        {selected && (
          <Card className="mt-4 p-4">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold">
                  {monthLabel(
                    calendar === 'shamsi' ? civilToJalali(selected).jy : selected.y,
                    calendar === 'shamsi' ? civilToJalali(selected).jm : selected.m,
                    calendar,
                    persianDigits,
                  )}{' '}
                  · {dayNumber(selected, calendar, persianDigits)}
                </h3>
                <p className="mt-0.5 text-xs text-muted">
                  {new Date(selected.y, selected.m - 1, selected.d).toLocaleDateString('en-CA', {
                    weekday: 'long',
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                  })}
                </p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setSelected(null)}>
                Close
              </Button>
            </div>

            {!selectedDay || (selectedDay.events.length === 0 && selectedDay.tasks.length === 0) ? (
              <p className="py-2 text-xs text-muted">Nothing scheduled.</p>
            ) : (
              <div className="space-y-1.5">
                {selectedDay.events.map((e) => (
                  <div key={e.id} className="flex items-center gap-2 text-sm">
                    <Badge tone="accent">Event</Badge>
                    <span>{e.title}</span>
                    {!e.allDay && (
                      <span className="tnum ml-auto text-xs text-muted">
                        {new Date(e.startsAt).toLocaleTimeString('en-CA', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    )}
                  </div>
                ))}
                {selectedDay.tasks.map((t) => (
                  <div key={t.id} className="flex items-center gap-2 text-sm">
                    <Badge>Task</Badge>
                    <span className={cn(t.status === 'done' && 'text-faint line-through')}>
                      {t.title}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        )}
      </Page>
    </>
  );
}
