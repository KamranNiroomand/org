import { useState } from 'react';
import { cn } from '../ui';
import { WatchList } from './WatchList';
import { AlertFeed } from './AlertFeed';
import { Radar } from './Radar';
import { Ask } from './Ask';

/**
 * The Watchlist tab.
 *
 * Four screens: the symbols you're following, the alerts that have fired
 * for them (plus holdings, plus anything else in the market — see
 * AlertFeed's own doc comment), the market-wide heuristic radar, and the
 * box (a ticker lookup or an open-ended question run through the
 * multi-agent panel). Radar rows drill into Ask via `askPrefill` — a radar
 * row click switches tabs and runs the panel for that symbol directly,
 * rather than duplicating PanelResult's rendering in two places.
 */

type SubTab = 'watching' | 'alerts' | 'radar' | 'ask';

const SUB_TABS: Array<[SubTab, string]> = [
  ['watching', 'Watching'],
  ['alerts', 'Alerts'],
  ['radar', 'Radar'],
  ['ask', 'Ask'],
];

export function WatchlistTab() {
  const [tab, setTab] = useState<SubTab>('alerts');
  const [askPrefill, setAskPrefill] = useState<{ symbol: string; token: number } | null>(null);

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
      {tab === 'radar' && (
        <Radar
          onDrillIn={(symbol) => {
            setAskPrefill({ symbol, token: Date.now() });
            setTab('ask');
          }}
        />
      )}
      {tab === 'ask' && <Ask prefill={askPrefill} />}
    </div>
  );
}
