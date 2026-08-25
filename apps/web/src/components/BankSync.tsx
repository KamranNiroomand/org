import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Building2, History, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlaidLink, type PlaidLinkOnSuccess } from 'react-plaid-link';
import { Badge, Button, Card, CardHeader, Empty, cn } from './ui';
import { api } from '../lib/api';

interface PlaidStatus {
  configured: boolean;
  environment: string;
  encryptionAvailable: boolean;
  nextRun: string | null;
  lastRun: {
    startedAt: string;
    banks: { items: number; added: number; modified: number; removed: number; categorized: number };
    prices: { symbols: number; quoted: number; usdCad: number | null };
    errors: string[];
  } | null;
  items: Array<{
    id: string;
    institutionName: string;
    status: 'ok' | 'needs_reauth' | 'error';
    error: string | null;
    lastSyncAt: string | null;
    accountCount: number;
  }>;
}

function relative(iso: string | null): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function until(iso: string | null): string {
  if (!iso) return 'not scheduled';
  const d = new Date(iso);
  return d.toLocaleString('en-CA', {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function BankSync() {
  const qc = useQueryClient();
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Why we opened Link decides what to do when it finishes: a fresh connect or
  // a reauth needs a token exchange, but "extend history" reuses an already
  // linked item — Plaid update mode widens its history window, so the only
  // follow-up is a sync to pull the newly available months.
  const linkIntent = useRef<{ mode: 'connect-reauth' | 'extend'; itemId?: string }>({
    mode: 'connect-reauth',
  });

  const { data: status } = useQuery({
    queryKey: ['plaid-status'],
    queryFn: () => api.get<PlaidStatus>('/api/plaid/status'),
    // The nightly job can land while the tab is open, so keep this fresh.
    refetchInterval: 60_000,
  });

  const refreshAll = () => {
    void qc.invalidateQueries({ queryKey: ['plaid-status'] });
    void qc.invalidateQueries({ queryKey: ['accounts'] });
    void qc.invalidateQueries({ queryKey: ['transactions'] });
    void qc.invalidateQueries({ queryKey: ['summary'] });
    void qc.invalidateQueries({ queryKey: ['cashflow'] });
  };

  const mintToken = useMutation({
    mutationFn: (itemId?: string) =>
      api.post<{ linkToken: string; mode: string }>('/api/plaid/link-token', { itemId }),
    onSuccess: (r) => setLinkToken(r.linkToken),
    onError: (e) => setNotice((e as Error).message),
  });

  const exchange = useMutation({
    mutationFn: (vars: { publicToken: string; institutionName?: string }) =>
      api.post<{ itemId: string; sync: { added: number; categorized: number } }>(
        '/api/plaid/exchange',
        vars,
      ),
    onSuccess: (r) => {
      setNotice(`Connected — pulled ${r.sync.added} transactions, categorized ${r.sync.categorized}.`);
      setLinkToken(null);
      refreshAll();
    },
    onError: (e) => setNotice((e as Error).message),
  });

  // Sync a single item — used after an "extend history" update, so only the
  // affected bank is re-pulled rather than the whole nightly job.
  const syncItem = useMutation({
    mutationFn: (itemId: string) =>
      api.post<Array<{ added: number; categorized: number }>>('/api/plaid/sync', { itemId }),
    onSuccess: (r) => {
      const added = r.reduce((n, o) => n + o.added, 0);
      const categorized = r.reduce((n, o) => n + o.categorized, 0);
      setNotice(`Backfilled — ${added} older transactions pulled, ${categorized} categorized.`);
      refreshAll();
    },
    onError: (e) => setNotice((e as Error).message),
  });

  const syncNow = useMutation({
    mutationFn: () =>
      api.post<{ banks: { added: number; categorized: number }; errors: string[] }>(
        '/api/sync/run',
      ),
    onSuccess: (r) => {
      setNotice(
        r.errors.length > 0
          ? r.errors.join(' · ')
          : `Synced — ${r.banks.added} new transactions, ${r.banks.categorized} categorized.`,
      );
      refreshAll();
    },
  });

  const disconnect = useMutation({
    mutationFn: (id: string) => api.del(`/api/plaid/items/${id}`),
    onSuccess: refreshAll,
  });

  // Plaid types the public token as nullable — it can come back null when Link
  // completes without a usable item. Exchanging null would 400, so bail early
  // with something the user can act on.
  const onLinkSuccess = useCallback<PlaidLinkOnSuccess>(
    (publicToken, metadata) => {
      const intent = linkIntent.current;
      setLinkToken(null);

      // Extend-history reuses an existing item: nothing to exchange, just pull
      // the wider window Plaid now exposes for it.
      if (intent.mode === 'extend' && intent.itemId) {
        syncItem.mutate(intent.itemId);
        return;
      }

      if (!publicToken) {
        setNotice('Plaid returned no token for that connection. Try again.');
        return;
      }
      exchange.mutate({
        publicToken,
        institutionName: metadata.institution?.name ?? undefined,
      });
    },
    [exchange, syncItem],
  );

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess: onLinkSuccess,
    onExit: () => setLinkToken(null),
  });

  /**
   * Opening Link is a side effect, so it belongs in an effect rather than the
   * render body. Clearing the token here as well would tear the handler down
   * before the modal could paint — it is cleared in onSuccess and onExit
   * instead, once Link itself is finished with it.
   */
  useEffect(() => {
    if (linkToken && ready) open();
  }, [linkToken, ready, open]);

  if (!status?.configured) {
    return (
      <Card className="mb-5 overflow-hidden">
        <CardHeader title="Automatic sync" subtitle="Not configured" />
        <div className="px-4 py-4 text-xs leading-relaxed text-muted">
          <p>
            To pull credit-card transactions in every night, add Plaid keys to{' '}
            <code className="font-mono text-text">.env</code>:
          </p>
          <pre className="mt-2 rounded-lg bg-bg-subtle p-3 font-mono text-[11px] text-text">
{`PLAID_CLIENT_ID=...
PLAID_SECRET=...`}
          </pre>
          <p className="mt-2">
            The free Trial plan covers 10 live bank connections — sign up at{' '}
            <span className="text-text">dashboard.plaid.com</span>, then restart the server.
          </p>
        </div>
      </Card>
    );
  }

  return (
    <Card className="mb-5 overflow-hidden">
      <CardHeader
        title="Automatic sync"
        subtitle={
          <>
            Next run {until(status.nextRun)}
            {status.environment === 'sandbox' && (
              <Badge tone="warning" className="ml-2">
                sandbox
              </Badge>
            )}
          </>
        }
        action={
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => syncNow.mutate()}
              disabled={syncNow.isPending}
            >
              <RefreshCw className={cn('size-3.5', syncNow.isPending && 'animate-spin')} />
              {syncNow.isPending ? 'Syncing…' : 'Sync now'}
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                linkIntent.current = { mode: 'connect-reauth' };
                mintToken.mutate(undefined);
              }}
              disabled={mintToken.isPending || !status.encryptionAvailable}
            >
              <Plus className="size-3.5" /> Connect
            </Button>
          </div>
        }
      />

      {!status.encryptionAvailable && (
        <div className="flex items-start gap-2 border-b border-border bg-warning/10 px-4 py-2.5 text-xs text-warning">
          <AlertTriangle className="mt-px size-3.5 shrink-0" />
          <span>
            The macOS Keychain is unreachable, so an access token could not be stored encrypted.
            Connecting is blocked rather than saving a bank credential in plaintext.
          </span>
        </div>
      )}

      {notice && (
        <div className="border-b border-border bg-bg-subtle px-4 py-2 text-xs text-muted">
          {notice}
        </div>
      )}

      {status.items.length === 0 ? (
        <Empty
          icon={<Building2 className="size-7" />}
          title="No banks connected"
          hint="Connect a card and Org pulls its transactions every night at 6am, categorizes them, and updates your balances."
        />
      ) : (
        <div className="divide-y divide-border">
          {status.items.map((item) => (
            <div key={item.id} className="group flex items-center gap-3 px-4 py-3">
              <div className="rounded-lg bg-bg-subtle p-2 text-muted">
                <Building2 className="size-4" />
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{item.institutionName}</span>
                  {item.status === 'needs_reauth' && <Badge tone="warning">reconnect</Badge>}
                  {item.status === 'error' && <Badge tone="negative">error</Badge>}
                </div>
                <div className="text-xs text-muted">
                  {item.accountCount} account{item.accountCount === 1 ? '' : 's'} · synced{' '}
                  {relative(item.lastSyncAt)}
                </div>
                {item.error && (
                  <div className="mt-0.5 text-[11px] text-negative">{item.error}</div>
                )}
              </div>

              {item.status === 'needs_reauth' ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    linkIntent.current = { mode: 'connect-reauth', itemId: item.id };
                    mintToken.mutate(item.id);
                  }}
                >
                  Reconnect
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  title="Pull older transactions Plaid didn't include when this bank was first connected"
                  disabled={mintToken.isPending || syncItem.isPending}
                  onClick={() => {
                    linkIntent.current = { mode: 'extend', itemId: item.id };
                    mintToken.mutate(item.id);
                  }}
                >
                  <History className="size-3.5" /> Extend history
                </Button>
              )}

              <button
                onClick={() => {
                  if (window.confirm(`Disconnect ${item.institutionName}? Its transactions stay in the ledger.`)) {
                    disconnect.mutate(item.id);
                  }
                }}
                className="rounded p-1 text-faint opacity-0 transition-opacity group-hover:opacity-100 hover:text-negative"
                aria-label={`Disconnect ${item.institutionName}`}
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {status.lastRun && (
        <div className="border-t border-border px-4 py-2 text-[11px] text-faint">
          Last run {relative(status.lastRun.startedAt)} · {status.lastRun.banks.added} new ·{' '}
          {status.lastRun.banks.categorized} categorized · {status.lastRun.prices.quoted}/
          {status.lastRun.prices.symbols} quotes
          {status.lastRun.errors.length > 0 && (
            <span className="text-negative"> · {status.lastRun.errors.length} error(s)</span>
          )}
        </div>
      )}
    </Card>
  );
}
