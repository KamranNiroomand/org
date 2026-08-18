import { Check, GripVertical, Pencil, Play, Square, Trash2, Flag } from 'lucide-react';
import type { DragEvent } from 'react';
import { elapsedSeconds, formatDuration, formatElapsed, type Task } from '@org/shared';
import { DualDate } from './DualDate';
import { PRIORITY_TONE } from './TaskComposer';
import { Badge, cn } from './ui';
import { useNow } from '../lib/useNow';
import { useTaskMutations } from '../lib/tasks';

interface DragHandles {
  itemProps: {
    draggable: boolean;
    onDragStart: (e: DragEvent) => void;
    onDragEnter: () => void;
    onDragOver: (e: DragEvent) => void;
    onDrop: (e: DragEvent) => void;
    onDragEnd: () => void;
  };
  gripProps: { onMouseDown: () => void; onMouseUp: () => void };
}

/**
 * One task, rendered the same way in the Todo list and inside a project so the
 * two can never drift apart.
 *
 * The time chip is the only conditional piece: a task with no estimate and no
 * tracked time shows nothing at all. Not a dash, not `0m` — an untimed task is
 * the normal case and should not look like a timed one that failed.
 */
export function TaskRow({
  task,
  today,
  projectName,
  drag,
  onEdit,
  className,
}: {
  task: Task;
  today: string;
  projectName?: string | null;
  drag?: DragHandles;
  onEdit?: (task: Task) => void;
  className?: string;
}) {
  const { toggle, remove, startTimer, stopTimer } = useTaskMutations();
  const running = task.timerStartedAt !== null;

  // Only the running row needs a clock; every other row re-renders never.
  const now = useNow(1000, running);
  const elapsed = elapsedSeconds(task.trackedSeconds, task.timerStartedAt, now);

  const hasTime = task.estimateMinutes !== null || task.trackedSeconds > 0 || running;
  const over = task.estimateMinutes !== null && elapsed > task.estimateMinutes * 60;

  return (
    <div
      {...drag?.itemProps}
      className={cn(
        'group flex items-center gap-2.5 px-3 py-2.5',
        drag?.itemProps.draggable && 'cursor-grabbing',
        className,
      )}
    >
      {drag && (
        <button
          {...drag.gripProps}
          aria-label="Reorder task"
          className="-ml-1 shrink-0 cursor-grab rounded p-0.5 text-faint opacity-0 transition-opacity group-hover:opacity-100"
        >
          <GripVertical className="size-3.5" />
        </button>
      )}

      <button
        onClick={() => toggle.mutate(task)}
        className={cn(
          'flex size-[18px] shrink-0 items-center justify-center rounded-[6px] border transition-colors',
          task.status === 'done'
            ? 'border-accent bg-accent text-white'
            : 'border-border-strong hover:border-accent',
        )}
        aria-label={task.status === 'done' ? 'Mark as open' : 'Mark as done'}
      >
        {task.status === 'done' && <Check className="size-3" strokeWidth={3} />}
      </button>

      <div className="min-w-0 flex-1">
        <div className={cn('truncate text-sm', task.status === 'done' && 'text-faint line-through')}>
          {task.title}
        </div>
        {(task.tags.length > 0 || projectName) && (
          <div className="mt-1 flex gap-1.5 text-[11px] text-faint">
            {projectName && <span className="truncate">{projectName}</span>}
            {task.tags.map((tag) => (
              <span key={tag}>#{tag}</span>
            ))}
          </div>
        )}
      </div>

      {hasTime && (
        <span
          className={cn(
            'tnum shrink-0 text-[11px]',
            running ? 'text-accent' : over ? 'text-warning' : 'text-muted',
          )}
          title={task.estimateMinutes === null ? 'Time tracked' : 'Tracked / estimated'}
        >
          {formatElapsed(elapsed)}
          {task.estimateMinutes !== null && ` / ${formatDuration(task.estimateMinutes)}`}
        </span>
      )}

      {task.priority !== 'none' && (
        <Badge tone={PRIORITY_TONE[task.priority]}>
          <Flag className="mr-0.5 size-2.5" />
          {task.priority}
        </Badge>
      )}

      {task.dueOn && (
        <span
          className={cn(
            'shrink-0 text-xs',
            task.dueOn < today && task.status === 'open' ? 'text-negative' : 'text-muted',
          )}
        >
          <DualDate date={task.dueOn} style="short" />
        </span>
      )}

      <button
        onClick={() => (running ? stopTimer.mutate(task.id) : startTimer.mutate(task.id))}
        // The running task keeps its button visible from across the page —
        // a timer you can only find by hovering is a timer left on overnight.
        className={cn(
          'shrink-0 rounded p-1 transition-opacity',
          running
            ? 'text-accent opacity-100'
            : 'text-faint opacity-0 group-hover:opacity-100 hover:text-accent',
        )}
        aria-label={running ? 'Stop timer' : 'Start timer'}
      >
        {running ? <Square className="size-3.5 fill-current" /> : <Play className="size-3.5" />}
      </button>

      {onEdit && (
        <button
          onClick={() => onEdit(task)}
          className="shrink-0 rounded p-1 text-faint opacity-0 transition-opacity group-hover:opacity-100 hover:text-text"
          aria-label="Edit task"
        >
          <Pencil className="size-3.5" />
        </button>
      )}

      <button
        onClick={() => remove.mutate(task.id)}
        className="shrink-0 rounded p-1 text-faint opacity-0 transition-opacity group-hover:opacity-100 hover:text-negative"
        aria-label="Delete task"
      >
        <Trash2 className="size-3.5" />
      </button>
    </div>
  );
}
