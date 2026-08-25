import { Send, Sparkles, Square } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button, Card, CardHeader, cn } from './ui';

/**
 * Chat with Claude about your own finances.
 *
 * Streams `/api/finance/chat` the same way the Ideas panel streams `assist` —
 * a plain-text chunked response read off the body. The server grounds every
 * answer in the real ledger (balances, category totals, recent transactions),
 * so this component only has to carry the conversation, not the data.
 */

interface Msg {
  role: 'user' | 'assistant';
  content: string;
}

const SUGGESTIONS = [
  'What did I spend the most on this month?',
  'How much did I spend on dining in the last few months?',
  'Any unusual charges recently?',
];

export function FinanceChat({ month }: { month: string }) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  async function send(text: string) {
    const question = text.trim();
    if (!question || streaming) return;

    const history: Msg[] = [...messages, { role: 'user', content: question }];
    // Optimistically render the question plus an empty assistant bubble the
    // stream fills in.
    setMessages([...history, { role: 'assistant', content: '' }]);
    setInput('');
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch('/api/finance/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ month, messages: history }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        appendToLast(`[${body?.error ?? `${res.status} ${res.statusText}`}]`, true);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        appendToLast(decoder.decode(value, { stream: true }));
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') appendToLast(`\n\n[${(err as Error).message}]`);
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  /** Append a delta to the in-flight assistant bubble (the last message). */
  function appendToLast(delta: string, replace = false): void {
    setMessages((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last?.role === 'assistant') {
        next[next.length - 1] = { ...last, content: replace ? delta : last.content + delta };
      }
      return next;
    });
  }

  function stop(): void {
    abortRef.current?.abort();
  }

  return (
    <Card className="flex h-full flex-col overflow-hidden">
      <CardHeader
        title={
          <span className="flex items-center gap-1.5">
            <Sparkles className="size-4 text-accent" /> Ask about your money
          </span>
        }
        subtitle="Grounded in your accounts and recent transactions"
      />

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {messages.length === 0 ? (
          <div className="space-y-2">
            <p className="text-xs text-muted">Ask a question, or try:</p>
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => void send(s)}
                className="block w-full rounded-lg border border-border bg-bg-subtle px-3 py-2 text-left text-xs text-text transition-colors hover:bg-bg-hover"
              >
                {s}
              </button>
            ))}
          </div>
        ) : (
          messages.map((m, i) => (
            <div
              key={i}
              className={cn(
                'max-w-[85%] rounded-2xl px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap',
                m.role === 'user'
                  ? 'ml-auto bg-accent/15 text-text'
                  : 'mr-auto bg-bg-subtle text-text',
              )}
            >
              {m.content || (streaming && i === messages.length - 1 ? '…' : '')}
            </div>
          ))
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
        className="flex items-center gap-2 border-t border-border px-3 py-2.5"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about your spending…"
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
        />
        {streaming ? (
          <Button type="button" size="sm" variant="ghost" onClick={stop}>
            <Square className="size-3.5" /> Stop
          </Button>
        ) : (
          <Button type="submit" size="sm" variant="primary" disabled={!input.trim()}>
            <Send className="size-3.5" />
          </Button>
        )}
      </form>
    </Card>
  );
}
