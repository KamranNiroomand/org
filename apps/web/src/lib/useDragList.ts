import { useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';

/**
 * Drag-to-reorder over a list, using native HTML5 drag events.
 *
 * The browser already provides the drag image, the drop cursor, and autoscroll.
 * A pointer-event implementation would mean hand-writing all three plus hit
 * testing — a few hundred lines to replace about fifty. The trade is no touch
 * support, which is fine for a desktop keyboard-first app.
 *
 * Order is user-controlled but layout is not: callers render into a flow or a
 * grid, so this only ever moves an item to a new index.
 */
export function useDragList<T extends { id: string }>(
  items: T[],
  onCommit: (ids: string[]) => void,
) {
  // A local override of the server's order, held only while a drag is in
  // flight. `null` means "trust the query"; the caller clears it once the
  // reorder mutation settles and the invalidated data arrives.
  const [override, setOverride] = useState<string[] | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const draggingRef = useRef(false);

  // While nothing is being dragged the server is the source of truth again.
  useEffect(() => {
    if (!draggingRef.current) setOverride(null);
  }, [items]);

  const byId = new Map(items.map((i) => [i.id, i]));
  const order =
    override === null
      ? items
      : (override.map((id) => byId.get(id)).filter(Boolean) as T[]);

  const ids = () => (override ?? order.map((i) => i.id));

  const move = (from: string, to: string) => {
    if (from === to) return;
    const next = [...ids()];
    const a = next.indexOf(from);
    const b = next.indexOf(to);
    if (a === -1 || b === -1) return;
    // Move, not swap — dragging past two items should push both, which is what
    // the drop indicator implies.
    next.splice(b, 0, ...next.splice(a, 1));
    setOverride(next);
  };

  const end = () => {
    draggingRef.current = false;
    setArmed(null);
    if (dragging) {
      const final = ids();
      setDragging(null);
      // Only worth a round trip if something actually moved.
      if (final.some((id, i) => items[i]?.id !== id)) onCommit(final);
    }
  };

  return {
    order,
    dragging,
    /** Clear the local override once the server order is authoritative again. */
    settle: () => setOverride(null),

    itemProps: (id: string) => ({
      // Only draggable once the grip is pressed: a permanently draggable card
      // swallows text selection inside its own textarea, and on a task row it
      // would hijack the checkbox click.
      draggable: armed === id,
      onDragStart: (e: DragEvent) => {
        draggingRef.current = true;
        setDragging(id);
        // Firefox refuses to start a drag with no payload.
        e.dataTransfer.setData('text/plain', id);
        e.dataTransfer.effectAllowed = 'move';
      },
      onDragEnter: () => {
        if (dragging) move(dragging, id);
      },
      // Without this there is no drop event at all.
      onDragOver: (e: DragEvent) => e.preventDefault(),
      onDrop: (e: DragEvent) => {
        e.preventDefault();
        end();
      },
      onDragEnd: end,
    }),

    gripProps: (id: string) => ({
      onMouseDown: () => setArmed(id),
      onMouseUp: () => setArmed((a) => (a === id ? null : a)),
    }),
  };
}
