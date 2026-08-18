import { useQuery } from '@tanstack/react-query';
import { Inbox } from 'lucide-react';
import { useMemo, useState } from 'react';
import { todayCivil, civilKey, type Task } from '@org/shared';
import { Page, PageHeader } from '../components/PageHeader';
import { StickyBoard } from '../components/StickyBoard';
import { TaskComposer } from '../components/TaskComposer';
import { TaskEditDialog } from '../components/TaskEditDialog';
import { TaskRow } from '../components/TaskRow';
import { Card, Empty, Skeleton, cn } from '../components/ui';
import { api } from '../lib/api';
import { taskKeys } from '../lib/tasks';

/**
 * The Todo tab is the *inbox*: loose tasks that belong to no project. Project
 * work lives on its project page, where it can be ordered and estimated against
 * the rest of that project — mixing the two here would make both lists worse.
 */
export function TodoPage() {
  const [filter, setFilter] = useState<'open' | 'done' | 'all'>('open');
  const [editing, setEditing] = useState<Task | null>(null);
  const today = civilKey(todayCivil());

  const { data: tasks, isLoading } = useQuery({
    queryKey: taskKeys.inbox(filter),
    queryFn: () => api.get<Task[]>(`/api/tasks?status=${filter}&projectId=none`),
  });

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
        {/* The notes rail sits beside the list on a wide screen and stacks
            underneath it on anything narrower, rather than squeezing both. */}
        <div className="xl:grid xl:grid-cols-[minmax(0,1fr)_22rem] xl:items-start xl:gap-6">
          <div className="min-w-0">
            <TaskComposer autoFocus className="mb-5" />

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
                      // No drag handle here on purpose: this list is grouped by
                      // date, and a manual order that reshuffles itself at
                      // midnight is worse than no manual order at all.
                      <TaskRow key={t.id} task={t} today={today} onEdit={setEditing} />
                    ))}
                  </Card>
                </section>
              ))}
            </div>
          </div>

          <div className="mt-8 xl:mt-0">
            <StickyBoard />
          </div>
        </div>
      </Page>

      <TaskEditDialog task={editing} onClose={() => setEditing(null)} />
    </>
  );
}
