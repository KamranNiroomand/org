import { useState } from 'react';
import { cn } from '../ui';
import { WatchList } from './WatchList';
import { AlertFeed } from './AlertFeed';
import { Radar } from './Radar';

/**
 * The Watchlist tab.
 *
 * Three screens: the symbols you're following, the alerts that have fired
 * for them (plus holdings, plus anything else in the market — see
 * AlertFeed's own doc comment), and the market-wide heuristic radar. Ask
 * joins this bar once the multi-agent panel lands.
 */

type SubTab = 'watching' | 'alerts' | 'radar';

const SUB_TABS: Array<[SubTab, string]> = [
  ['watching', 'Watching'],
  ['alerts', 'Alerts'],
  ['radar', 'Radar'],
];

export function WatchlistTab() {
  const [tab, setTab] = useState<SubTab>('alerts');

  return (
    <div>
      <div className="mb-4 flex gap-1 border-b border-border">
        {SUB_TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-xs font-medium transition-colors',
              tab === key ? 'border-accent text-text' : 'border-transparent text-muted hover:text-text',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'watching' && <WatchList />}
      {tab === 'alerts' && <AlertFeed />}
      {tab === 'radar' && <Radar />}
    </div>
  );
}
