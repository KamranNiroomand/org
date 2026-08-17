import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lightbulb, Plus, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Page, PageHeader } from '../components/PageHeader';
import { Button, Card, Empty, Input, Skeleton, cn } from '../components/ui';
import { api } from '../lib/api';
import { useSettings } from '../lib/settings';

interface Idea {
  id: string;
  title: string;
  body: string;
  tags: string[];
  status: 'seed' | 'growing' | 'parked' | 'shipped';
  updatedAt: string;
}

type Action = 'expand' | 'critique' | 'relate';

const ACTIONS: Array<{ key: Action; label: string; hint: string }> = [
  { key: 'expand', label: 'Expand', hint: 'Develop the thought further' },
  { key: 'critique', label: 'Critique', hint: 'Find the holes' },
  { key: 'relate', label: 'Relate', hint: 'Surface connected ideas' },
];

export function IdeasPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { health } = useSettings();

  const [title, setTitle] = useState('');
  const [draft, setDraft] = useState('');
  const [assist, setAssist] = useState('');
  const [running, setRunning] = useState<Action | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const { data: list, isLoading } = useQuery({
    queryKey: ['ideas'],
    queryFn: () => api.get<Idea[]>('/api/ideas'),
  });

  const { data: idea } = useQuery({
    queryKey: ['idea', id],
    queryFn: () => api.get<Idea>(`/api/ideas/${id}`),
    enabled: Boolean(id),
  });

  useEffect(() => {
    if (idea) setDraft(idea.body);
    setAssist('');
  }, [idea?.id]);

  const create = useMutation({
    mutationFn: () => api.post<Idea>('/api/ideas', { title, body: '' }),
    onSuccess: (created) => {
      setTitle('');
      void qc.invalidateQueries({ queryKey: ['ideas'] });
      navigate(`/ideas/${created.id}`);
    },
  });

  const save = useMutation({
    mutationFn: (body: string) => api.patch(`/api/ideas/${id}`, { body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['ideas'] });
      void qc.invalidateQueries({ queryKey: ['idea', id] });
    },
  });

  const remove = useMutation({
    mutationFn: (ideaId: string) => api.del(`/api/ideas/${ideaId}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['ideas'] });
      navigate('/ideas');
    },
  });

  const breakdown = useMutation({
    mutationFn: () =>
      api.post<{ projectId: string; projectName: string; taskCount: number }>(
        `/api/ideas/${id}/breakdown`,
      ),
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: ['projects'] });
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      navigate(`/projects/${result.projectId}`);
    },
  });

  /**
   * Streams the response into the panel as it arrives. Fetch rather than the
   * api client because this is a text stream, not JSON — waiting for the whole
   * body would leave the panel blank for the length of the response.
   */
  async function runAssist(action: Action) {
    if (!id) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setRunning(action);
    setAssist('');

    try {
      const res = await fetch(`/api/ideas/${id}/assist`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setAssist(`[${body?.error ?? `${res.status} ${res.statusText}`}]`);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        setAssist((prev) => prev + decoder.decode(value, { stream: true }));
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setAssist(`[${(err as Error).message}]`);
      }
    } finally {
      setRunning(null);
    }
  }

  const claudeReady = health?.features.claude ?? false;

  return (
    <>
      <PageHeader
        title="Ideas"
        subtitle={
          claudeReady
            ? 'Claude assist available'
            : 'Add ANTHROPIC_API_KEY to .env to enable Claude assist'
        }
      />

      <Page>
        <div className="grid gap-4 lg:grid-cols-[16rem_1fr_20rem]">
          {/* List */}
          <div className="space-y-2">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (title.trim()) create.mutate();
              }}
              className="flex gap-1.5"
            >
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="New idea"
                className="h-8 text-xs"
              />
              <Button type="submit" size="sm" variant="primary" disabled={!title.trim()}>
                <Plus className="size-3.5" />
              </Button>
            </form>

            {isLoading && <Skeleton className="h-32" />}

            <div className="space-y-1">
              {list?.map((i) => (
                <button
                  key={i.id}
                  onClick={() => navigate(`/ideas/${i.id}`)}
                  className={cn(
                    'w-full rounded-lg px-2.5 py-2 text-left text-sm transition-colors',
                    i.id === id ? 'bg-accent-soft text-accent' : 'hover:bg-bg-subtle',
                  )}
                >
                  <div className="truncate">{i.title}</div>
                  <div className="mt-0.5 text-[11px] text-faint">{i.status}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Editor */}
          <Card className="flex min-h-[28rem] flex-col overflow-hidden">
            {!id ? (
              <Empty
                icon={<Lightbulb className="size-7" />}
                title="Pick an idea, or start a new one"
                hint="Drafts live here. Claude can expand them, poke holes in them, or turn one into a real project with real tasks."
              />
            ) : (
              <>
                <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
                  <h2 className="truncate text-sm font-semibold">{idea?.title}</h2>
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => save.mutate(draft)}
                      disabled={save.isPending || draft === idea?.body}
                    >
                      {save.isPending ? 'Saving…' : draft === idea?.body ? 'Saved' : 'Save'}
                    </Button>
                    <button
                      onClick={() => remove.mutate(id)}
                      className="rounded p-1.5 text-faint hover:text-negative"
                      aria-label="Delete idea"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                </div>

                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => draft !== idea?.body && save.mutate(draft)}
                  placeholder={'Write freely. Markdown works, and [[double brackets]] link to other ideas.'}
                  className="flex-1 resize-none bg-transparent p-4 font-mono text-sm leading-relaxed outline-none placeholder:text-faint"
                  spellCheck
                />
              </>
            )}
          </Card>

          {/* Claude panel */}
          <Card className="flex min-h-[28rem] flex-col overflow-hidden">
            <div className="flex items-center gap-1.5 border-b border-border px-4 py-2.5">
              <Sparkles className="size-3.5 text-accent" />
              <span className="text-sm font-semibold">Claude</span>
            </div>

            {!id ? (
              <p className="p-4 text-xs text-muted">Select an idea to get started.</p>
            ) : !claudeReady ? (
              <div className="p-4 text-xs text-muted">
                <p>Claude assist is off.</p>
                <p className="mt-2">
                  Add <code className="font-mono text-text">ANTHROPIC_API_KEY</code> to{' '}
                  <code className="font-mono text-text">.env</code> and restart the server.
                </p>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-1.5 p-3">
                  {ACTIONS.map((a) => (
                    <Button
                      key={a.key}
                      size="sm"
                      variant="secondary"
                      onClick={() => void runAssist(a.key)}
                      disabled={running !== null}
                      title={a.hint}
                    >
                      {running === a.key ? '…' : a.label}
                    </Button>
                  ))}
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => breakdown.mutate()}
                    disabled={breakdown.isPending || running !== null}
                    title="Turn this into a project with real tasks"
                  >
                    {breakdown.isPending ? '…' : 'Break down'}
                  </Button>
                </div>

                <div className="flex-1 overflow-y-auto border-t border-border px-4 py-3">
                  {assist ? (
                    <div className="text-xs leading-relaxed whitespace-pre-wrap">{assist}</div>
                  ) : breakdown.isError ? (
                    <p className="text-xs text-negative">
                      {(breakdown.error as Error).message}
                    </p>
                  ) : (
                    <p className="text-xs text-muted">
                      Expand develops the idea, Critique finds the holes, Relate connects it to
                      your other notes, and Break down turns it into a project you can actually
                      start.
                    </p>
                  )}
                </div>
              </>
            )}
          </Card>
        </div>
      </Page>
    </>
  );
}
