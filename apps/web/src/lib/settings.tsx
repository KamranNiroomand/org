import { useQuery } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { CalendarSystem } from '@org/shared';
import { api, type Health } from './api';

type Theme = 'light' | 'dark' | 'system';

interface Settings {
  /** Which calendar leads in the UI. */
  calendar: CalendarSystem;
  setCalendar: (c: CalendarSystem) => void;
  /** Render Shamsi dates in Persian script and digits. */
  persianDigits: boolean;
  setPersianDigits: (v: boolean) => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
  baseCurrency: string;
  health: Health | undefined;
}

const SettingsContext = createContext<Settings | null>(null);

function usePersisted<T extends string | boolean>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(() => {
    const raw = localStorage.getItem(`org.${key}`);
    if (raw === null) return fallback;
    return (typeof fallback === 'boolean' ? raw === 'true' : raw) as T;
  });

  const set = useCallback(
    (next: T) => {
      setValue(next);
      localStorage.setItem(`org.${key}`, String(next));
    },
    [key],
  );

  return [value, set] as const;
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [calendar, setCalendar] = usePersisted<CalendarSystem>('calendar', 'miladi');
  const [persianDigits, setPersianDigits] = usePersisted<boolean>('persianDigits', true);
  const [theme, setTheme] = usePersisted<Theme>('theme', 'system');

  const { data: health } = useQuery({
    queryKey: ['health'],
    queryFn: () => api.get<Health>('/api/health'),
    staleTime: Infinity,
  });

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
  }, [theme]);

  const value = useMemo<Settings>(
    () => ({
      calendar,
      setCalendar,
      persianDigits,
      setPersianDigits,
      theme,
      setTheme,
      baseCurrency: health?.baseCurrency ?? 'CAD',
      health,
    }),
    [calendar, setCalendar, persianDigits, setPersianDigits, theme, setTheme, health],
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): Settings {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used inside SettingsProvider');
  return ctx;
}
