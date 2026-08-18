import * as Dialog from '@radix-ui/react-dialog';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CalendarDays,
  CircleDollarSign,
  CornerDownLeft,
  Home,
  Lightbulb,
  ListTodo,
  LayoutGrid,
  Plus,
  TrendingUp,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { parseQuickAdd } from '@org/shared';
import { api } from '../lib/api';
import { invalidateTasks } from '../lib/tasks';
import { cn } from './ui';

interface Command {
  id: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  run: () => void | Promise<void>;
  group: string;
}

interface Idea {
  id: string;
  title: string;
}
interface Project {
  id: string;
  name: string;
}

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Only fetched while the palette is open, so it costs nothing at rest.
  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<Project[]>('/api/projects'),
    enabled: open,
  });
  const { data: ideas } = useQuery({
    queryKey: ['ideas'],
    queryFn: () => api.get<Idea[]>('/api/ideas'),
    enabled: open,
  });

  const createTask = useMutation({
    mutationFn: (line: string) => {
      const parsed = parseQuickAdd(line);
      return api.post('/api/tasks', {
        title: parsed.title,
        dueOn: parsed.dueOn,
        priority: parsed.priority,
        tags: parsed.tags,
      });
    },
    onSuccess: () => {
      invalidateTasks(qc);
      onOpenChange(false);
      navigate('/todo');
    },
  });

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
    }
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const nav: Command[] = [
      { id: 'today', label: 'Today', icon: <Home className="size-4" />, run: () => navigate('/today'), group: 'Go to' },
      { id: 'todo', label: 'Todo', icon: <ListTodo className="size-4" />, run: () => navigate('/todo'), group: 'Go to' },
      { id: 'projects', label: 'Projects', icon: <LayoutGrid className="size-4" />, run: () => navigate('/projects'), group: 'Go to' },
      { id: 'calendar', label: 'Calendar', icon: <CalendarDays className="size-4" />, run: () => navigate('/calendar'), group: 'Go to' },
      { id: 'finances', label: 'Finances', icon: <CircleDollarSign className="size-4" />, run: () => navigate('/finances'), group: 'Go to' },
      { id: 'investments', label: 'Investments', icon: <TrendingUp className="size-4" />, run: () => navigate('/investments'), group: 'Go to' },
      { id: 'ideas', label: 'Ideas', icon: <Lightbulb className="size-4" />, run: () => navigate('/ideas'), group: 'Go to' },
    ];

    const entities: Command[] = [
      ...(projects ?? []).map((p) => ({
        id: `project-${p.id}`,
        label: p.name,
        icon: <LayoutGrid className="size-4" />,
        run: () => navigate(`/projects/${p.id}`),
        group: 'Projects',
      })),
      ...(ideas ?? []).map((i) => ({
        id: `idea-${i.id}`,
        label: i.title,
        icon: <Lightbulb className="size-4" />,
        run: () => navigate(`/ideas/${i.id}`),
        group: 'Ideas',
      })),
    ];

    const q = query.trim().toLowerCase();
    const filtered = [...nav, ...entities].filter((c) => c.label.toLowerCase().includes(q));

    // Anything typed can always become a task. Shown first once the query stops
    // matching a destination, so the palette degrades into a capture box rather
    // than a dead end.
    if (q.length > 0) {
      const parsed = parseQuickAdd(query);
      const create: Command = {
        id: 'create-task',
        label: `Create task “${parsed.title || query}”`,
        hint: [
          parsed.dueOn && `due ${parsed.dueOn}`,
          parsed.priority !== 'none' && parsed.priority,
          ...parsed.tags.map((t) => `#${t}`),
        ]
          .filter(Boolean)
          .join(' · '),
        icon: <Plus className="size-4" />,
        run: async () => {
          await createTask.mutateAsync(query);
        },
        group: 'Create',
      };
      return filtered.length > 0 ? [...filtered, create] : [create];
    }

    return filtered;
  }, [query, projects, ideas, navigate, createTask]);

  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(commands.length - 1, 0)));
  }, [commands.length]);

  const grouped = useMemo(() => {
    const map = new Map<string, Array<Command & { index: number }>>();
    commands.forEach((c, index) => {
      const list = map.get(c.group) ?? [];
      list.push({ ...c, index });
      map.set(c.group, list);
    });
    return [...map.entries()];
  }, [commands]);

  const runActive = () => {
    const cmd = commands[active];
    if (!cmd) return;
    void cmd.run();
    if (cmd.id !== 'create-task') onOpenChange(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/25 backdrop-blur-[2px]" />
        <Dialog.Content
          className="fixed top-[18%] left-1/2 z-50 w-[min(560px,92vw)] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-panel shadow-2xl"
          // Radix moves focus to the dialog itself by default; redirect it to
          // the search box so the palette is type-ready the moment it opens.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            inputRef.current?.focus();
          }}
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <Dialog.Description className="sr-only">
            Search, navigate, or type anything to create a task.
          </Dialog.Description>

          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => (a + 1) % Math.max(commands.length, 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => (a - 1 + commands.length) % Math.max(commands.length, 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                runActive();
              }
            }}
            placeholder="Search, or type a task…"
            className="w-full border-b border-border bg-transparent px-4 py-3.5 text-sm outline-none placeholder:text-faint"
          />

          <div ref={listRef} className="max-h-[52vh] overflow-y-auto p-1.5">
            {commands.length === 0 && (
              <p className="px-3 py-6 text-center text-xs text-muted">Nothing found</p>
            )}

            {grouped.map(([group, items]) => (
              <div key={group} className="mb-1">
                <div className="px-2.5 py-1 text-[10px] font-medium tracking-wide text-faint uppercase">
                  {group}
                </div>
                {items.map((c) => (
                  <button
                    key={c.id}
                    onMouseEnter={() => setActive(c.index)}
                    onClick={runActive}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors',
                      c.index === active ? 'bg-accent-soft text-accent' : 'text-text',
                    )}
                  >
                    <span className="shrink-0 opacity-70">{c.icon}</span>
                    <span className="min-w-0 flex-1 truncate">{c.label}</span>
                    {c.hint && <span className="shrink-0 text-[11px] text-muted">{c.hint}</span>}
                    {c.index === active && <CornerDownLeft className="size-3 shrink-0 opacity-50" />}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
