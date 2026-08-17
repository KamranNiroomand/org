import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  elapsedSeconds,
  formatDuration,
  formatElapsed,
  parseDuration,
  type Project,
  type Task,
} from '@org/shared';
import { api } from '../lib/api';
import { useTaskMutations } from '../lib/tasks';
import { Button, Input, Modal, Select, Textarea } from './ui';

const PRIORITIES: Array<[string, string]> = [
  ['none', 'No priority'],
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
  ['urgent', 'Urgent'],
];

/**
 * The one place a task can be edited. There is no inline rename anywhere, so
 * every field lives together and nothing is only reachable from one screen —
 * including the project, which is what moves a task in or out of the Todo list.
 */
export function TaskEditDialog({ task, onClose }: { task: Task | null; onClose: () => void }) {
  const { update, remove } = useTaskMutations();
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [priority, setPriority] = useState('none');
  const [dueOn, setDueOn] = useState('');
  const [estimate, setEstimate] = useState('');
  const [projectId, setProjectId] = useState('');

  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<Project[]>('/api/projects'),
    enabled: task !== null,
  });

  // Reset the form whenever a different task is opened.
  useEffect(() => {
    if (!task) return;
    setTitle(task.title);
    setNotes(task.notes ?? '');
    setPriority(task.priority);
    setDueOn(task.dueOn ?? '');
    setEstimate(task.estimateMinutes === null ? '' : formatDuration(task.estimateMinutes));
    setProjectId(task.projectId ?? '');
  }, [task]);

  if (!task) return null;

  const typed = estimate.trim();
  const parsedEstimate = typed === '' ? null : parseDuration(typed);
  const estimateInvalid = typed !== '' && parsedEstimate === null;
  const tracked = elapsedSeconds(task.trackedSeconds, task.timerStartedAt);

  const save = () => {
    if (estimateInvalid || !title.trim()) return;
    update.mutate({
      id: task.id,
      title: title.trim(),
      notes: notes.trim() === '' ? null : notes,
      priority,
      dueOn: dueOn === '' ? null : dueOn,
      estimateMinutes: parsedEstimate,
      projectId: projectId === '' ? null : projectId,
    });
    onClose();
  };

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Edit task"
      footer={
        <>
          <Button
            variant="danger"
            size="sm"
            onClick={() => {
              remove.mutate(task.id);
              onClose();
            }}
          >
            Delete
          </Button>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={save}
              disabled={estimateInvalid || !title.trim()}
            >
              Save
            </Button>
          </div>
        </>
      }
    >
      <div className="space-y-3.5">
        <Field label="Title">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </Field>

        <Field label="Notes">
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Anything worth remembering about this one"
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Due">
            <Input type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} />
          </Field>
          <Field label="Priority">
            <Select
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
              options={PRIORITIES}
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Estimate"
            // Echoing the normalised value makes the accepted syntax
            // discoverable without a help string nobody reads.
            hint={
              typed === ''
                ? 'Optional'
                : estimateInvalid
                  ? 'Try 45m, 2h, or 1h30'
                  : formatDuration(parsedEstimate!)
            }
            hintTone={estimateInvalid ? 'negative' : 'muted'}
          >
            <Input
              value={estimate}
              onChange={(e) => setEstimate(e.target.value)}
              placeholder="2h"
            />
          </Field>
          <Field label="Project">
            <Select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              options={[
                ['', '— none (Todo) —'],
                ...(projects ?? []).map((p) => [p.id, p.name] as [string, string]),
              ]}
            />
          </Field>
        </div>

        <div className="flex items-center justify-between border-t border-border pt-3">
          <div className="text-xs text-muted">
            Tracked <span className="tnum text-text">{formatElapsed(tracked)}</span>
          </div>
          {tracked > 0 && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => update.mutate({ id: task.id, trackedSeconds: 0 })}
            >
              Reset
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

function Field({
  label,
  hint,
  hintTone = 'muted',
  children,
}: {
  label: string;
  hint?: string;
  hintTone?: 'muted' | 'negative';
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-[11px] font-medium tracking-wide text-muted uppercase">{label}</span>
        {hint && (
          <span className={hintTone === 'negative' ? 'text-[11px] text-negative' : 'text-[11px] text-faint'}>
            {hint}
          </span>
        )}
      </div>
      {children}
    </label>
  );
}
