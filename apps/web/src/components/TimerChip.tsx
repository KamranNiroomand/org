import { useQuery } from '@tanstack/react-query';
import { Square } from 'lucide-react';
import { elapsedSeconds, formatElapsed, type Task } from '@org/shared';
import { api } from '../lib/api';
import { taskKeys, useTaskMutations } from '../lib/tasks';
import { useNow } from '../lib/useNow';

/**
 * The running timer, visible from every tab.
 *
 * This is the payoff for allowing only one at a time: there is exactly one
 * thing to show, and a timer you can't see from the page you wandered off to is
 * a timer still running tomorrow morning.
 */
export function TimerChip() {
  const { stopTimer } = useTaskMutations();
  const { data } = useQuery({
    queryKey: taskKeys.timer,
    queryFn: () => api.get<{ task: Task | null }>('/api/tasks/timer/active'),
  });

  const task = data?.task ?? null;
  const now = useNow(1000, task !== null);
  if (!task) return null;

  return (
    <div className="flex items-center gap-2 rounded-lg bg-accent-soft px-2 py-1.5 text-[11px] text-accent">
      <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
      <span className="min-w-0 flex-1 truncate" title={task.title}>
        {task.title}
      </span>
      <span className="tnum shrink-0 font-medium">
        {formatElapsed(elapsedSeconds(task.trackedSeconds, task.timerStartedAt, now))}
      </span>
      <button
        onClick={() => stopTimer.mutate(task.id)}
        aria-label="Stop timer"
        className="shrink-0 rounded p-0.5 transition-opacity hover:opacity-70"
      >
        <Square className="size-3 fill-current" />
      </button>
    </div>
  );
}
