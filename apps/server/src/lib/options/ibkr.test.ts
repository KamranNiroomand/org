import { describe, expect, it } from 'vitest';
import { fetchIbkrQuotes, parseOcc } from './ibkr.js';
import { config } from '../../config.js';

const OCC = 'GWW   261016C01380000';

describe('parseOcc', () => {
  it('splits a padded OCC symbol into the CP API vocabulary', () => {
    expect(parseOcc(OCC)).toEqual({
      underlying: 'GWW',
      maturity: '20261016',
      month: 'OCT26',
      strike: 1380,
      right: 'C',
    });
  });

  it('reads fractional strikes and puts', () => {
    expect(parseOcc('BRK.B 260918P00465500')).toMatchObject({
      underlying: 'BRK.B',
      strike: 465.5,
      right: 'P',
    });
  });

  it('refuses garbage rather than guessing', () => {
    expect(parseOcc('not an occ symbol')).toBeNull();
    expect(parseOcc('GWW   261316C01380000')).toBeNull(); // month 13
  });
});

type Responses = Record<string, unknown>;

const getFrom =
  (responses: Responses) =>
  async (_base: string, path: string): Promise<unknown> => {
    for (const [prefix, body] of Object.entries(responses)) {
      if (path.startsWith(prefix)) return body;
    }
    return null;
  };

const HAPPY: Responses = {
  '/iserver/accounts': { accounts: ['DU123'] },
  '/trsrv/stocks': { GWW: [{ contracts: [{ conid: 111, isUS: true }] }] },
  '/iserver/secdef/info': [
    { conid: 999, maturityDate: '20261009', right: 'C' }, // the weekly decoy
    { conid: 777, maturityDate: '20261016', right: 'C' },
  ],
  '/iserver/marketdata/snapshot': [{ conid: 777, '31': '20.10', '84': '19.80', '86': '20.40' }],
};

describe('fetchIbkrQuotes', () => {
  it('is dormant without a gateway url', async () => {
    expect((await fetchIbkrQuotes([OCC], getFrom(HAPPY), 0)).size).toBe(0);
  });

  it('resolves the exact expiry (not a same-month weekly) and maps NBBO to E4', async () => {
    (config.market as { ibkrGatewayUrl: string | null }).ibkrGatewayUrl = 'https://localhost:5000/v1/api';
    try {
      const quotes = await fetchIbkrQuotes([OCC], getFrom(HAPPY), 0);
      expect(quotes.get(OCC)).toEqual({ bidE4: 198_000, askE4: 204_000, lastE4: 201_000 });
    } finally {
      (config.market as { ibkrGatewayUrl: string | null }).ibkrGatewayUrl = null;
    }
  });

  it('degrades to an empty map when the gateway answers nothing — never throws', async () => {
    (config.market as { ibkrGatewayUrl: string | null }).ibkrGatewayUrl = 'https://localhost:5000/v1/api';
    try {
      const quotes = await fetchIbkrQuotes([OCC], async () => null, 0);
      expect(quotes.size).toBe(0);
    } finally {
      (config.market as { ibkrGatewayUrl: string | null }).ibkrGatewayUrl = null;
    }
  });
});
