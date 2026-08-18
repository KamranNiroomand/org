import { useState } from 'react';
import { cn } from '../ui';
import { CorpusStatus } from './CorpusStatus';
import { PaperBook } from './PaperBook';

/**
 * The Options tab, in its first real form.
 *
 * Two screens, both wired to what actually exists today: corpus health and
 * the paper book. There is no ranked signal board yet — `rank.py` and the
 * model behind it aren't built — so this is deliberately not a chain
 * browser or a recommendation list. It is somewhere to watch the pipeline
 * work and to run paper trades by hand while that catches up.
 */

type SubTab = 'status' | 'paper';

const SUB_TABS: Array<[SubTab, string]> = [
  ['status', 'Status'],
  ['paper', 'Paper book'],
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
      {tab === 'paper' && <PaperBook />}
    </div>
  );
}
