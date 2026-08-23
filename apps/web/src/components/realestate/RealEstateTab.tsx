import { useState } from 'react';
import { cn } from '../ui';
import { PropertyForm } from './PropertyForm';
import { AnalysisResult } from './AnalysisResult';
import { RunHistoryList } from './RunHistoryList';

/**
 * The real-estate investment assistant. Two sub-tabs: analyze a listing
 * (form + result, or the result alone once a run exists), and history
 * (past runs, click to reopen). Same local-state sub-tab shell as
 * `WatchlistTab.tsx`.
 */

type SubTab = 'analyze' | 'history';

const SUB_TABS: Array<[SubTab, string]> = [
  ['analyze', 'Analyze'],
  ['history', 'History'],
];

export function RealEstateTab() {
  const [tab, setTab] = useState<SubTab>('analyze');
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

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

      {tab === 'analyze' &&
        (activeRunId ? (
          <div className="space-y-3">
            <button type="button" onClick={() => setActiveRunId(null)} className="text-xs text-muted hover:text-text">
              ← New analysis
            </button>
            <AnalysisResult runId={activeRunId} />
          </div>
        ) : (
          <PropertyForm onStarted={(res) => setActiveRunId(res.runId)} />
        ))}

      {tab === 'history' && (
        <RunHistoryList
          onSelect={(runId) => {
            setActiveRunId(runId);
            setTab('analyze');
          }}
        />
      )}
    </div>
  );
}
