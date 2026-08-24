import { useState } from 'react';
import { cn } from '../ui';
import { CorpusStatus } from './CorpusStatus';
import { ModelPerformance } from './ModelPerformance';
import { PaperBook } from './PaperBook';
import { SignalBoard } from './SignalBoard';

/**
 * The Options tab.
 *
 * Three screens: corpus health, the ranked signal board, and the paper book.
 * The signal board is the primary way to place a paper trade now — the open
 * form on the paper book itself remains for typing in a symbol the board
 * didn't rank, not as the main path.
 */

type SubTab = 'status' | 'signals' | 'paper' | 'performance';

const SUB_TABS: Array<[SubTab, string]> = [
  ['status', 'Status'],
  ['signals', 'Signals'],
  ['paper', 'Paper book'],
  // Model quality only — trading P&L stays on the paper book. See
  // ModelPerformance's own docstring on why the two never share a panel.
  ['performance', 'Model'],
];

export function OptionsTab() {
  const [tab, setTab] = useState<SubTab>('status');

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

      {tab === 'status' && <CorpusStatus />}
      {tab === 'signals' && <SignalBoard />}
      {tab === 'paper' && <PaperBook />}
      {tab === 'performance' && <ModelPerformance />}
    </div>
  );
}
