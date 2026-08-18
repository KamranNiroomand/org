import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LayoutGrid, Plus } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  civilKey,
  formatDuration,
  formatElapsed,
  todayCivil,
  type Project,
  type ProjectWithStats,
  type Task,
} from '@org/shared';
import { DualDate } from '../components/DualDate';
import { Page, PageHeader } from '../components/PageHeader';
import { TaskComposer } from '../components/TaskComposer';
import { TaskEditDialog } from '../components/TaskEditDialog';
import { TaskRow } from '../components/TaskRow';
import { Badge, Button, Card, Empty, Input, Modal, Select, Skeleton, Textarea } from '../components/ui';
import { api } from '../lib/api';
import { invalidateTasks, taskKeys, useTaskMutations } from '../lib/tasks';
import { useDragList } from '../lib/useDragList';

interface ProjectDetail extends Project {
  tasks: Task[];
}

export function ProjectsPage() {
  const { id } = useParams();
  return id ? <ProjectDetailView id={id} /> : <ProjectListView />;
}

function ProjectListView() {
  const [name, setName] = useState('');
  const qc = useQueryClient();
  const navigate = useNavigate();

  const { data: projects, isLoading } = useQuery({
    queryKey: taskKeys.projects,
    queryFn: () => api.get<ProjectWithStats[]>('/api/projects'),
  });

  const create = useMutation({
    mutationFn: () => api.post<Project>('/api/projects', { name }),
    onSuccess: (project) => {
      setName('');
      void qc.invalidateQueries({ queryKey: taskKeys.projects });
      // Straight into the project, where the task composer is already focused —
      // a new project's whole point is the tasks you are about to type into it.
      navigate(`/projects/${project.id}`);
    },
  });

  return (
    <>
      <PageHeader title="Projects" subtitle={projects ? `${projects.length} total` : undefined} />
      <Page>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
          className="mb-5 flex gap-2"
        >
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="New project name"
          />
          <Button type="submit" variant="primary" disabled={!name.trim()}>
            <Plus className="size-3.5" /> Create
          </Button>
        </form>

        {isLoading && <Skeleton className="h-32" />}

        {projects?.length === 0 && (
          <Card>
            <Empty
              icon={<LayoutGrid className="size-7" />}
              title="No projects yet"
              hint="Name one above and you can start adding its tasks straight away."
            />
          </Card>
        )}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {projects?.map((p) => {
            const pct = p.taskCount === 0 ? 0 : (p.doneCount / p.taskCount) * 100;
            const timed = p.estimateMinutes > 0 || p.trackedSeconds > 0;
            return (
              <Card
                key={p.id}
                onClick={() => navigate(`/projects/${p.id}`)}
                className="cursor-pointer p-4 transition-colors hover:border-border-strong"
              >
                <div className="flex items-start justify-between gap-2">
                  <h3 className="truncate text-sm font-semibold">{p.name}</h3>
                  <Badge
                    tone={
                      p.status === 'active' ? 'accent' : p.status === 'done' ? 'positive' : 'neutral'
                    }
                  >
                    {p.status}
                  </Badge>
                </div>

                {p.description && (
                  <p className="mt-1 line-clamp-2 text-xs text-muted">{p.description}</p>
                )}

                <div className="mt-3">
                  <div className="mb-1.5 flex items-center justify-between text-[11px] text-muted">
                    <span className="tnum">
                      {p.doneCount}/{p.taskCount} done
                    </span>
                    {p.overdueCount > 0 && (
                      <span className="text-negative">{p.overdueCount} overdue</span>
                    )}
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-bg-subtle">
                    <div
                      className="h-full rounded-full bg-accent transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>

                {timed && (
                  <div className="tnum mt-2 text-[11px] text-muted">
                    {formatElapsed(p.trackedSeconds)}
                    {p.estimateMinutes > 0 && ` / ${formatDuration(p.estimateMinutes)}`}
                  </div>
                )}

                {p.targetOn && (
                  <div className="mt-3 text-[11px] text-muted">
                    Target <DualDate date={p.targetOn} style="short" />
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      </Page>
    </>
  );
}

function ProjectDetailView({ id }: { id: string }) {
  const navigate = useNavigate();
  const [editing, setEditing] = useState<Task | null>(null);
  const [editingProject, setEditingProject] = useState(false);
  const today = civilKey(todayCivil());
  const { reorder } = useTaskMutations();

  const { data, isLoading } = useQuery({
    queryKey: taskKeys.project(id),
    queryFn: () => api.get<ProjectDetail>(`/api/projects/${id}`),
  });

  const drag = useDragList(data?.tasks ?? [], (ids) =>
    reorder.mutate(ids, { onSettled: () => drag.settle() }),
  );

  if (isLoading) {
    return (
      <Page>
        <Skeleton className="h-48" />
      </Page>
    );
  }
  if (!data) return null;

  const open = data.tasks.filter((t) => t.status === 'open').length;
  const done = data.tasks.filter((t) => t.status === 'done').length;
  const estimate = data.tasks.reduce((s, t) => s + (t.estimateMinutes ?? 0), 0);
  const tracked = data.tasks.reduce((s, t) => s + t.trackedSeconds, 0);

  return (
    <>
      <PageHeader
        title={data.name}
        subtitle={data.description ?? undefined}
        actions={
          <div className="flex gap-1.5">
            <Button size="sm" variant="secondary" onClick={() => setEditingProject(true)}>
              Edit
            </Button>
            <Button size="sm" variant="ghost" onClick={() => navigate('/projects')}>
              All projects
            </Button>
          </div>
        }
      />
      <Page>
        <TaskComposer projectId={id} autoFocus placeholder="Add a task…" className="mb-5" />

        <div className="mb-1.5 flex items-center gap-2 px-1 text-[11px] text-faint">
          <span>{open} open</span>
          <span className="opacity-40">·</span>
          <span>{done} done</span>
          {(estimate > 0 || tracked > 0) && (
            <>
              <span className="opacity-40">·</span>
              <span className="tnum">
                {formatElapsed(tracked)}
                {estimate > 0 && ` / ${formatDuration(estimate)}`}
              </span>
            </>
          )}
        </div>

        <Card className="overflow-hidden">
          {data.tasks.length === 0 ? (
            <Empty title="No tasks yet" hint="Type above to add the first one." />
          ) : (
            <div className="divide-y divide-border">
              {drag.order.map((t) => (
                <TaskRow key={t.id} task={t} today={today} onEdit={setEditing} drag={{
                  itemProps: drag.itemProps(t.id),
                  gripProps: drag.gripProps(t.id),
                }} className={drag.dragging === t.id ? 'opacity-40' : undefined} />
              ))}
            </div>
          )}
        </Card>
      </Page>

      <TaskEditDialog task={editing} onClose={() => setEditing(null)} />
      {editingProject && (
        <ProjectEditDialog project={data} onClose={() => setEditingProject(false)} />
      )}
    </>
  );
}

const STATUSES: Array<[string, string]> = [
  ['active', 'Active'],
  ['paused', 'Paused'],
  ['done', 'Done'],
  ['archived', 'Archived'],
];

function ProjectEditDialog({ project, onClose }: { project: ProjectDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? '');
  const [status, setStatus] = useState(project.status);
  const [targetOn, setTargetOn] = useState(project.targetOn ?? '');

  const save = useMutation({
    mutationFn: () =>
      api.patch(`/api/projects/${project.id}`, {
        name: name.trim(),
        description: description.trim() === '' ? null : description,
        status,
        targetOn: targetOn === '' ? null : targetOn,
      }),
    onSuccess: () => {
      invalidateTasks(qc);
      onClose();
    },
  });

  const remove = useMutation({
    mutationFn: () => api.del(`/api/projects/${project.id}`),
    onSuccess: () => {
      invalidateTasks(qc);
      navigate('/projects');
    },
  });

  const taskCount = project.tasks.length;

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Edit project"
      footer={
        <>
          <Button
            variant="danger"
            size="sm"
            onClick={() => {
              // Deleting a project does not delete its work — the schema nulls
              // the reference — so say where the tasks are about to go.
              const msg = taskCount
                ? `Delete “${project.name}”? Its ${taskCount} task${taskCount === 1 ? '' : 's'} move back to Todo.`
                : `Delete “${project.name}”?`;
              if (confirm(msg)) remove.mutate();
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
              onClick={() => save.mutate()}
              disabled={!name.trim()}
            >
              Save
            </Button>
          </div>
        </>
      }
    >
      <div className="space-y-3.5">
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium tracking-wide text-muted uppercase">
            Name
          </span>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>

        <label className="block">
          <span className="mb-1 block text-[11px] font-medium tracking-wide text-muted uppercase">
            Description
          </span>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What is this project for?"
          />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium tracking-wide text-muted uppercase">
              Status
            </span>
            <Select
              value={status}
              onChange={(e) => setStatus(e.target.value as typeof status)}
              options={STATUSES}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium tracking-wide text-muted uppercase">
              Target
            </span>
            <Input type="date" value={targetOn} onChange={(e) => setTargetOn(e.target.value)} />
          </label>
        </div>
      </div>
    </Modal>
  );
}
