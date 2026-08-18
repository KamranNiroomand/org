import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { Task } from '@org/shared';
import { api } from './api';

/**
 * Query keys that more than one page reads, named here so nothing hand-writes
 * `['project', id]` and quietly falls out of the invalidation set.
 */
export const taskKeys = {
  /** The Todo list: tasks belonging to no project. */
  inbox: (filter: string) => ['tasks', filter, 'inbox'] as const,
  project: (id: string) => ['project', id] as const,
  projects: ['projects'] as const,
  agenda: ['agenda'] as const,
  timer: ['timer'] as const,
};

/**
 * Everything a task mutation can dirty.
 *
 * `['project']` is a *prefix*, deliberately: moving a task between projects
 * invalidates two detail views and the mutation only knows about one of them.
 * `['calendar']` is a prefix for the same reason — its keys carry a date range
 * (`['calendar', from, to]`), and changing a due date should not leave whatever
 * month happens to be open showing the old one.
 */
export function invalidateTasks(qc: QueryClient): void {
  for (const key of [['tasks'], ['agenda'], ['projects'], ['project'], ['calendar'], ['timer']]) {
    void qc.invalidateQueries({ queryKey: key });
  }
}

export interface TaskDraft {
  title: string;
  notes?: string | null;
  dueOn?: string | null;
  priority?: string;
  tags?: string[];
  projectId?: string | null;
  estimateMinutes?: number | null;
}

export interface TaskPatch extends Partial<TaskDraft> {
  status?: string;
  /** Editable so time logged away from the keyboard can be corrected by hand. */
  trackedSeconds?: number;
}

/**
 * The task mutations, shared by the Todo list and the project detail so the two
 * cannot drift. No optimistic updates: the server is on localhost, and the one
 * place a round trip would be visible — dragging — holds its own local order.
 */
export function useTaskMutations() {
  const qc = useQueryClient();
  const settle = { onSuccess: () => invalidateTasks(qc) };

  return {
    create: useMutation({
      mutationFn: (draft: TaskDraft) => api.post<Task>('/api/tasks', draft),
      ...settle,
    }),
    update: useMutation({
      mutationFn: ({ id, ...patch }: TaskPatch & { id: string }) =>
        api.patch<Task>(`/api/tasks/${id}`, patch),
      ...settle,
    }),
    toggle: useMutation({
      mutationFn: (t: Task) =>
        api.patch<Task>(`/api/tasks/${t.id}`, { status: t.status === 'done' ? 'open' : 'done' }),
      ...settle,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api.del(`/api/tasks/${id}`),
      ...settle,
    }),
    reorder: useMutation({
      mutationFn: (ids: string[]) => api.post('/api/tasks/reorder', { ids }),
      ...settle,
    }),
    startTimer: useMutation({
      mutationFn: (id: string) => api.post(`/api/tasks/${id}/timer/start`),
      ...settle,
    }),
    stopTimer: useMutation({
      mutationFn: (id: string) => api.post(`/api/tasks/${id}/timer/stop`),
      ...settle,
    }),
  };
}
