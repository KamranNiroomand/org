import {
  CalendarDays,
  CircleDollarSign,
  Home,
  Lightbulb,
  ListTodo,
  Moon,
  Search,
  LayoutGrid,
  Sun,
  TrendingUp,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { formatDual, todayCivil } from '@org/shared';
import { CommandPalette } from './CommandPalette';
import { TimerChip } from './TimerChip';
import { cn } from './ui';
import { useSettings } from '../lib/settings';

const NAV = [
  { to: '/today', label: 'Today', icon: Home, key: '1' },
  { to: '/todo', label: 'Todo', icon: ListTodo, key: '2' },
  { to: '/projects', label: 'Projects', icon: LayoutGrid, key: '3' },
  { to: '/calendar', label: 'Calendar', icon: CalendarDays, key: '4' },
  { to: '/finances', label: 'Finances', icon: CircleDollarSign, key: '5' },
  { to: '/investments', label: 'Investments', icon: TrendingUp, key: '6' },
  { to: '/ideas', label: 'Ideas', icon: Lightbulb, key: '7' },
] as const;

export function Shell() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { calendar, setCalendar, theme, setTheme, persianDigits } = useSettings();
  const navigate = useNavigate();

  const today = todayCivil();
  const dual = formatDual(today, { style: 'long', persian: persianDigits });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }

      // ⌘1-7 jump between tabs — but only when the user isn't typing, or the
      // shortcut would swallow digits mid-sentence.
      const target = e.target as HTMLElement | null;
      const typing =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable;

      if ((e.metaKey || e.ctrlKey) && !typing) {
        const hit = NAV.find((n) => n.key === e.key);
        if (hit) {
          e.preventDefault();
          navigate(hit.to);
        }
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);

  return (
    <div className="flex h-full">
      <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-bg-subtle">
        <div className="px-4 pt-5 pb-4">
          <div className="text-[15px] font-semibold tracking-tight">Org</div>
          <div className="mt-1.5 space-y-0.5 text-[11px] leading-relaxed text-muted">
            <div className="tnum">{dual.miladi}</div>
            <div className={cn('tnum', persianDigits && 'fa')} dir={persianDigits ? 'rtl' : 'ltr'}>
              {dual.shamsi}
            </div>
          </div>
        </div>

        <button
          onClick={() => setPaletteOpen(true)}
          className="mx-3 mb-3 flex items-center gap-2 rounded-lg border border-border bg-panel px-2.5 py-1.5 text-xs text-muted transition-colors hover:bg-bg"
        >
          <Search className="size-3.5" />
          <span>Search</span>
          <kbd className="ml-auto rounded border border-border px-1 py-px font-sans text-[10px] text-faint">
            ⌘K
          </kbd>
        </button>

        <nav className="flex-1 space-y-0.5 px-3">
          {NAV.map(({ to, label, icon: Icon, key }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn(
                  'group flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-sm transition-colors',
                  isActive
                    ? 'bg-accent-soft font-medium text-accent'
                    : 'text-muted hover:bg-panel hover:text-text',
                )
              }
            >
              <Icon className="size-4 shrink-0" />
              <span className="truncate">{label}</span>
              <kbd className="ml-auto text-[10px] text-faint opacity-0 transition-opacity group-hover:opacity-100">
                ⌘{key}
              </kbd>
            </NavLink>
          ))}
        </nav>

        <div className="space-y-2 border-t border-border p-3">
          <TimerChip />

          <div className="flex rounded-lg border border-border bg-panel p-0.5 text-[11px]">
            {(['miladi', 'shamsi'] as const).map((sys) => (
              <button
                key={sys}
                onClick={() => setCalendar(sys)}
                className={cn(
                  'flex-1 rounded-md py-1 transition-colors',
                  calendar === sys ? 'bg-accent-soft font-medium text-accent' : 'text-muted',
                )}
              >
                {sys === 'miladi' ? 'Miladi' : 'شمسی'}
              </button>
            ))}
          </div>

          <button
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-muted transition-colors hover:bg-panel"
          >
            {theme === 'dark' ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
            {theme === 'dark' ? 'Light' : 'Dark'} mode
          </button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}
