import { Plus } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { parseQuickAdd, type Priority } from '@org/shared';
import { DualDate } from './DualDate';
import { Badge, Button, Input } from './ui';
import { useTaskMutations } from '../lib/tasks';

export const PRIORITY_TONE: Record<Priority, 'neutral' | 'accent' | 'warning' | 'negative'> = {
  none: 'neutral',
  low: 'neutral',
  medium: 'accent',
  high: 'warning',
  urgent: 'negative',
};

/**
 * The quick-add bar.
 *
 * Given a `projectId` it files everything it creates into that project and
 * returns focus to the box, so a new project can be filled in by typing its
 * tasks one line after another.
 */
export function TaskComposer({
  projectId = null,
  autoFocus = false,
  placeholder = 'pay hydro bill friday !high #home',
  className,
}: {
  projectId?: string | null;
  autoFocus?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const { create } = useTaskMutations();

  // Live preview of what the line will produce, so the syntax is discoverable
  // by using it rather than by reading documentation.
  const preview = useMemo(() => (draft.trim() ? parseQuickAdd(draft) : null), [draft]);

  const submit = () => {
    const line = draft.trim();
    if (!line) return;

    const p = parseQuickAdd(line);
    create.mutate(
      { title: p.title, dueOn: p.dueOn, priority: p.priority, tags: p.tags, projectId },
      // Put the line back if the server refused it. Clearing optimistically is
      // what lets you type a list without waiting on each round trip, but it
      // must not be the reason a task quietly never existed.
      { onError: () => setDraft(line) },
    );
    setDraft('');
    inputRef.current?.focus();
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className={className}
    >
      <div className="flex gap-2">
        <Input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          // Enter is handled here rather than left to the form's implicit
          // submission, which is easy to lose to a stray wrapper or a browser
          // quirk. preventDefault stops the two paths firing together.
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={placeholder}
          className="h-11"
          autoFocus={autoFocus}
        />
        <Button type="submit" variant="primary" className="h-11" disabled={!draft.trim()}>
          <Plus className="size-3.5" /> Add
        </Button>
      </div>

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
  );
}
