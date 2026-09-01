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

describe('shortlistForAgent (full board)', () => {
  it('judges every usable name, most interesting first', () => {
    const rows = [
      row({ symbol: 'WEATHER', quadrant: 'chase' }),
      row({ symbol: 'CB', quadrant: 'contrarian_bid' }),
      row({ symbol: 'HELD', held: true }),
      row({ symbol: 'MOVER', delta_5d: 0.4 }),
    ];
    const picked = shortlistForAgent(rows).map((r) => r.symbol);
    expect(picked).toEqual(['CB', 'HELD', 'MOVER', 'WEATHER']); // priority order
    expect(picked).toHaveLength(4); // nothing usable is excluded
  });

  it('the stampede cap still bounds a pathological board', () => {
    const rows = Array.from({ length: 300 }, (_, i) => row({ symbol: `S${i}` }));
    expect(shortlistForAgent(rows)).toHaveLength(150);
  });

  it('unquadranted rows never reach the agent', () => {
    expect(shortlistForAgent([row({ quadrant: null, delta_5d: 2 })])).toHaveLength(0);
  });
});
