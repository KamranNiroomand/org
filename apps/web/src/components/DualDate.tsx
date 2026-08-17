import {
  civilHoliday,
  formatDual,
  formatIn,
  parseCivilKey,
  type CivilDate,
  type DateStyle,
} from '@org/shared';
import { useSettings } from '../lib/settings';
import { cn } from './ui';

/**
 * Renders a day in whichever calendar leads, with the other one available on
 * hover. Both systems are always present in the DOM — the toggle changes
 * emphasis, not availability, which is the point of a dual calendar.
 */
export function DualDate({
  date,
  style = 'medium',
  className,
  showBoth = false,
}: {
  /** A civil date, or a `YYYY-MM-DD` key. */
  date: CivilDate | string;
  style?: DateStyle;
  className?: string;
  showBoth?: boolean;
}) {
  const { calendar, persianDigits } = useSettings();
  const civil = typeof date === 'string' ? parseCivilKey(date) : date;

  const dual = formatDual(civil, { style, persian: persianDigits });
  const lead = formatIn(civil, calendar, { style, persian: persianDigits });
  const other = calendar === 'shamsi' ? dual.miladi : dual.shamsi;
  const holiday = civilHoliday(civil);

  if (showBoth) {
    return (
      <span className={cn('inline-flex items-baseline gap-1.5', className)}>
        <span className="tnum">{lead}</span>
        <span
          className={cn('tnum text-xs text-faint', calendar === 'miladi' && persianDigits && 'fa')}
        >
          {other}
        </span>
      </span>
    );
  }

  return (
    <span
      className={cn('tnum', calendar === 'shamsi' && persianDigits && 'fa', className)}
      dir={calendar === 'shamsi' && persianDigits ? 'rtl' : 'ltr'}
      title={holiday ? `${other} · ${holiday.name}` : other}
    >
      {lead}
    </span>
  );
}
