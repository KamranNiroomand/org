import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GripVertical, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { STICKY_COLORS, type StickyColor, type StickyNote } from '@org/shared';
import { api } from '../lib/api';
import { useDragList } from '../lib/useDragList';
import { Button, cn } from './ui';

/**
 * Tailwind v4 extracts class names statically, so a template literal like
 * `bg-sticky-${color}` compiles to nothing at all — the same failure already
 * sitting dead elsewhere in this app. Spelling every class out is what makes
 * these colours actually exist in the stylesheet.
 */
const SURFACE: Record<StickyColor, string> = {
  yellow: 'bg-sticky-yellow border-sticky-yellow-line',
  amber: 'bg-sticky-amber border-sticky-amber-line',
  green: 'bg-sticky-green border-sticky-green-line',
  blue: 'bg-sticky-blue border-sticky-blue-line',
  violet: 'bg-sticky-violet border-sticky-violet-line',
  pink: 'bg-sticky-pink border-sticky-pink-line',
  slate: 'bg-sticky-slate border-sticky-slate-line',
};

const SWATCH: Record<StickyColor, string> = {
  yellow: 'bg-sticky-yellow',
  amber: 'bg-sticky-amber',
  green: 'bg-sticky-green',
  blue: 'bg-sticky-blue',
  violet: 'bg-sticky-violet',
  pink: 'bg-sticky-pink',
  slate: 'bg-sticky-slate',
};

/**
 * Sticky notes: the scraps that aren't tasks.
 *
 * You choose the order by dragging; the grid chooses the alignment. There are
 * no coordinates to store and nothing to tidy up afterwards, which is the point
 * — a free canvas gets messy exactly as fast as a real desk does.
 */
export function StickyBoard() {
  const qc = useQueryClient();
  const [focusId, setFocusId] = useState<string | null>(null);

  const { data: notes } = useQuery({
    queryKey: ['stickies'],
    queryFn: () => api.get<StickyNote[]>('/api/stickies'),
  });

  // Stickies are read nowhere else, so they keep their own invalidation rather
  // than riding along with the task mutations.
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['stickies'] });

  const create = useMutation({
    mutationFn: () => api.post<StickyNote>('/api/stickies', {}),
    onSuccess: (note) => {
      setFocusId(note.id);
      invalidate();
    },
  });

  const patch = useMutation({
    mutationFn: ({ id, ...body }: { id: string; body?: string; color?: StickyColor }) =>
      api.patch<StickyNote>(`/api/stickies/${id}`, body),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/stickies/${id}`),
    onSuccess: invalidate,
  });

  const reorder = useMutation({
    mutationFn: (ids: string[]) => api.post('/api/stickies/reorder', { ids }),
    onSuccess: invalidate,
    onSettled: () => drag.settle(),
  });

  const drag = useDragList(notes ?? [], (ids) => reorder.mutate(ids));

  return (
    <section>
      <div className="mb-1.5 flex items-center justify-between px-1">
        <h2 className="text-[11px] font-semibold tracking-wide text-faint uppercase">
          Notes{' '}
          {notes && notes.length > 0 && <span className="font-normal opacity-60">{notes.length}</span>}
        </h2>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => create.mutate()}
          className="-mr-1.5 h-6 px-1.5 text-faint"
          aria-label="Add a note"
        >
          <Plus className="size-3.5" />
        </Button>
      </div>

      {notes?.length === 0 ? (
        <button
          onClick={() => create.mutate()}
          className="w-full rounded-lg border border-dashed border-border-strong px-3 py-7 text-xs text-faint transition-colors hover:border-accent hover:text-accent"
        >
          Add a note
        </button>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-2.5">
          {drag.order.map((note) => (
            <Note
              key={note.id}
              note={note}
              drag={drag}
              autoFocus={note.id === focusId}
              onBlurred={() => setFocusId(null)}
              onChangeBody={(body) => patch.mutate({ id: note.id, body })}
              onChangeColor={(color) => patch.mutate({ id: note.id, color })}
              onDelete={() => remove.mutate(note.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function Note({
  note,
  drag,
  autoFocus,
  onBlurred,
  onChangeBody,
  onChangeColor,
  onDelete,
}: {
  note: StickyNote;
  drag: ReturnType<typeof useDragList<StickyNote>>;
  autoFocus: boolean;
  onBlurred: () => void;
  onChangeBody: (body: string) => void;
  onChangeColor: (color: StickyColor) => void;
  onDelete: () => void;
}) {
  const [text, setText] = useState(note.body);
  const ref = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Someone else's edit (or an undo of ours) should win over an untouched box.
  useEffect(() => {
    if (document.activeElement !== ref.current) setText(note.body);
  }, [note.body]);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const save = (value: string) => {
    clearTimeout(timer.current);
    if (value !== note.body) onChangeBody(value);
  };

  return (
    <div
      {...drag.itemProps(note.id)}
      className={cn(
        'group/note relative flex min-h-30 flex-col rounded-lg border p-2.5 transition-opacity',
        SURFACE[note.color],
        drag.dragging === note.id && 'opacity-50',
      )}
    >
      <button
        {...drag.gripProps(note.id)}
        aria-label="Reorder note"
        className="absolute top-1 left-1 cursor-grab rounded p-0.5 text-text/35 opacity-0 transition-opacity group-hover/note:opacity-100"
      >
        <GripVertical className="size-3" />
      </button>

      <button
        onClick={onDelete}
        aria-label="Delete note"
        className="absolute top-1 right-1 rounded p-0.5 text-text/35 opacity-0 transition-opacity group-hover/note:opacity-100 hover:text-negative"
      >
        <Trash2 className="size-3" />
      </button>

      <textarea
        ref={ref}
        value={text}
        placeholder="Write something…"
        onChange={(e) => {
          setText(e.target.value);
          // Typing shouldn't cost a request per keystroke, but nothing should
          // be lost if the tab is closed a second later either.
          clearTimeout(timer.current);
          const value = e.target.value;
          timer.current = setTimeout(() => onChangeBody(value), 700);
        }}
        onBlur={() => {
          save(text);
          onBlurred();
        }}
        className="mt-2.5 field-sizing-content min-h-16 flex-1 resize-none bg-transparent text-[13px] leading-snug text-text outline-none placeholder:text-text/30"
      />

      <div className="mt-1.5 flex gap-1 opacity-0 transition-opacity group-hover/note:opacity-100">
        {STICKY_COLORS.map((c) => (
          <button
            key={c}
            onClick={() => onChangeColor(c)}
            aria-label={c}
            className={cn(
              'size-3 rounded-full border transition-transform hover:scale-115',
              SWATCH[c],
              c === note.color ? 'border-text/45' : 'border-text/15',
            )}
          />
        ))}
      </div>
    </div>
  );
}
