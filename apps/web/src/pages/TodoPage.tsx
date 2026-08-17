import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Flag, Inbox, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { parseQuickAdd, todayCivil, civilKey, type Priority } from '@org/shared';
import { DualDate } from '../components/DualDate';
import { Page, PageHeader } from '../components/PageHeader';
import { Badge, Card, Empty, Input, Skeleton, cn } from '../components/ui';
import { api } from '../lib/api';

interface Task {
  id: string;
  title: string;
  notes: string | null;
  status: 'open' | 'done' | 'dropped';
  priority: Priority;
  dueOn: string | null;
  projectId: string | null;
  tags: string[];
}

const PRIORITY_TONE: Record<Priority, 'neutral' | 'accent' | 'warning' | 'negative'> = {
  none: 'neutral',
  low: 'neutral',
  medium: 'accent',
  high: 'warning',
  urgent: 'negative',
};

export function TodoPage() {
  const [filter, setFilter] = useState<'open' | 'done' | 'all'>('open');
  const [draft, setDraft] = useState('');
  const qc = useQueryClient();
  const today = civilKey(todayCivil());

  const { data: tasks, isLoading } = useQuery({
    queryKey: ['tasks', filter],
    queryFn: () => api.get<Task[]>(`/api/tasks?status=${filter}`),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['tasks'] });
    void qc.invalidateQueries({ queryKey: ['agenda'] });
    void qc.invalidateQueries({ queryKey: ['projects'] });
  };

  const create = useMutation({
    mutationFn: (line: string) => {
      const p = parseQuickAdd(line);
      return api.post('/api/tasks', {
        title: p.title,
        dueOn: p.dueOn,
        priority: p.priority,
        tags: p.tags,
      });
    },
    onSuccess: () => {
      setDraft('');
      invalidate();
    },
  });

  const toggle = useMutation({
    mutationFn: (t: Task) =>
      api.patch(`/api/tasks/${t.id}`, { status: t.status === 'done' ? 'open' : 'done' }),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/tasks/${id}`),
    onSuccess: invalidate,
  });

  // Live preview of what the quick-add line will produce, so the syntax is
  // discoverable by using it rather than by reading documentation.
  const preview = useMemo(() => (draft.trim() ? parseQuickAdd(draft) : null), [draft]);

  const groups = useMemo(() => {
    if (!tasks) return [];
    const buckets = new Map<string, Task[]>();
    const put = (k: string, t: Task) => buckets.set(k, [...(buckets.get(k) ?? []), t]);

    for (const t of tasks) {
      if (t.status === 'done') put('Done', t);
      else if (!t.dueOn) put('No date', t);
      else if (t.dueOn < today) put('Overdue', t);
      else if (t.dueOn === today) put('Today', t);
      else put('Upcoming', t);
    }

    const order = ['Overdue', 'Today', 'Upcoming', 'No date', 'Done'];
    return order.filter((k) => buckets.has(k)).map((k) => [k, buckets.get(k)!] as const);
  }, [tasks, today]);

  return (
    <>
      <PageHeader
        title="Todo"
        subtitle={tasks ? `${tasks.filter((t) => t.status === 'open').length} open` : undefined}
        actions={
          <div className="flex rounded-lg border border-border bg-panel p-0.5 text-xs">
            {(['open', 'done', 'all'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={cn(
                  'rounded-md px-2.5 py-1 capitalize transition-colors',
                  filter === f ? 'bg-accent-soft font-medium text-accent' : 'text-muted',
                )}
              >
                {f}
              </button>
            ))}
          </div>
        }
      />

      <Page>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) create.mutate(draft);
          }}
          className="mb-5"
        >
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="pay hydro bill friday !high #home"
            className="h-11"
            autoFocus
          />
          {preview && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 px-1 text-xs text-muted">
              <span className="text-text">{preview.title || '…'}</span>
              {preview.dueOn && (
                <Badge tone="accent">
                  <DualDate date={preview.dueOn} style="short" />
                </Badge>
              )}
              {preview.priority !== 'none' && (
                <Badge tone={PRIORITY_TONE[preview.priority]}>{preview.priority}</Badge>
              )}
              {preview.tags.map((t) => (
                <Badge key={t}>#{t}</Badge>
              ))}
            </div>
          )}
        </form>

        {isLoading && (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        )}

        {tasks?.length === 0 && (
          <Card>
            <Empty
              icon={<Inbox className="size-7" />}
              title="Nothing here"
              hint="Type above to add your first task. Try “review budget friday !high #money”."
            />
          </Card>
        )}

        <div className="space-y-6">
          {groups.map(([label, items]) => (
            <section key={label}>
              <h2
                className={cn(
                  'mb-1.5 px-1 text-[11px] font-semibold tracking-wide uppercase',
                  label === 'Overdue' ? 'text-negative' : 'text-faint',
                )}
              >
                {label} <span className="font-normal opacity-60">{items.length}</span>
              </h2>

              <Card className="divide-y divide-border overflow-hidden">
                {items.map((t) => (
                  <div key={t.id} className="group flex items-center gap-3 px-3 py-2.5">
                    <button
                      onClick={() => toggle.mutate(t)}
                      className={cn(
                        'flex size-[18px] shrink-0 items-center justify-center rounded-[6px] border transition-colors',
                        t.status === 'done'
                          ? 'border-accent bg-accent text-white'
                          : 'border-border-strong hover:border-accent',
                      )}
                      aria-label={t.status === 'done' ? 'Mark as open' : 'Mark as done'}
                    >
                      {t.status === 'done' && <Check className="size-3" strokeWidth={3} />}
                    </button>

                    <div className="min-w-0 flex-1">
                      <div
                        className={cn(
                          'truncate text-sm',
                          t.status === 'done' && 'text-faint line-through',
                        )}
                      >
                        {t.title}
                      </div>
                      {t.tags.length > 0 && (
                        <div className="mt-1 flex gap-1">
                          {t.tags.map((tag) => (
                            <span key={tag} className="text-[11px] text-faint">
                              #{tag}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    {t.priority !== 'none' && (
                      <Badge tone={PRIORITY_TONE[t.priority]}>
                        <Flag className="mr-0.5 size-2.5" />
                        {t.priority}
                      </Badge>
                    )}

                    {t.dueOn && (
                      <span
                        className={cn(
                          'shrink-0 text-xs',
                          t.dueOn < today && t.status === 'open' ? 'text-negative' : 'text-muted',
                        )}
                      >
                        <DualDate date={t.dueOn} style="short" />
                      </span>
                    )}

                    <button
                      onClick={() => remove.mutate(t.id)}
                      className="shrink-0 rounded p-1 text-faint opacity-0 transition-opacity group-hover:opacity-100 hover:text-negative"
                      aria-label="Delete task"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                ))}
              </Card>
            </section>
          ))}
        </div>
      </Page>
    </>
  );
}
