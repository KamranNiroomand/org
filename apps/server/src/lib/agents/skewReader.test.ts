import { describe, expect, it } from 'vitest';
import { shortlistForAgent, type SkewRowForAgent } from './skewReader.js';

const row = (over: Partial<SkewRowForAgent>): SkewRowForAgent => ({
  symbol: 'X',
  sector: 'Tech',
  quadrant: 'hedged_rally',
  skew_norm: 0.2,
  skew_pts: 0.05,
  delta_5d: 0,
  sector_rank_pct: 50,
  ret_1m: 5,
  ret_1m_vs_spy: 2,
  rvol: 1,
  event_flag: false,
  held: false,
  sentence: 's',
  ...over,
});

describe('shortlistForAgent', () => {
  it('surfaces clean contrarian bids, held or fast-rising hedged rallies, and big movers', () => {
    const rows = [
      row({ symbol: 'CB', quadrant: 'contrarian_bid' }),
      row({ symbol: 'CBEV', quadrant: 'contrarian_bid', event_flag: true }), // event-tainted: out
      row({ symbol: 'HRHELD', held: true }),
      row({ symbol: 'HRFAST', delta_5d: 0.3 }),
      row({ symbol: 'HRSLOW', delta_5d: 0.01 }), // ordinary weather: out unless a top mover
      row({ symbol: 'MOVER', quadrant: 'fear', delta_5d: -0.9 }),
    ];
    const picked = shortlistForAgent(rows, 4).map((r) => r.symbol);
    expect(picked).toContain('CB');
    expect(picked).toContain('HRHELD');
    expect(picked).toContain('HRFAST');
    expect(picked).toContain('MOVER');
    expect(picked).not.toContain('CBEV');
    expect(picked).not.toContain('HRSLOW');
  });

  it('the cap holds on a wild day — a stampede cannot spend the budget', () => {
    const rows = Array.from({ length: 50 }, (_, i) =>
      row({ symbol: `S${i}`, quadrant: 'contrarian_bid' }),
    );
    expect(shortlistForAgent(rows, 12)).toHaveLength(12);
  });

  it('unquadranted rows never reach the agent', () => {
    expect(shortlistForAgent([row({ quadrant: null, delta_5d: 2 })])).toHaveLength(0);
  });
});
