import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LayoutGrid, Plus } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { DualDate } from '../components/DualDate';
import { Page, PageHeader } from '../components/PageHeader';
import { Badge, Button, Card, Empty, Input, Skeleton, cn } from '../components/ui';
import { api } from '../lib/api';

interface Project {
  id: string;
  name: string;
  description: string | null;
  status: 'active' | 'paused' | 'done' | 'archived';
  color: string;
  targetOn: string | null;
  taskCount: number;
  doneCount: number;
  overdueCount: number;
}

interface ProjectDetail extends Omit<Project, 'taskCount' | 'doneCount' | 'overdueCount'> {
  tasks: Array<{ id: string; title: string; status: string; dueOn: string | null }>;
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
    queryKey: ['projects'],
    queryFn: () => api.get<Project[]>('/api/projects'),
  });

  const create = useMutation({
    mutationFn: () => api.post<Project>('/api/projects', { name }),
    onSuccess: () => {
      setName('');
      void qc.invalidateQueries({ queryKey: ['projects'] });
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
              hint="Group related tasks into a project to track progress in one place."
            />
          </Card>
        )}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {projects?.map((p) => {
            const pct = p.taskCount === 0 ? 0 : (p.doneCount / p.taskCount) * 100;
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
  const { data, isLoading } = useQuery({
    queryKey: ['project', id],
    queryFn: () => api.get<ProjectDetail>(`/api/projects/${id}`),
  });

  if (isLoading) {
    return (
      <Page>
        <Skeleton className="h-48" />
      </Page>
    );
  }
  if (!data) return null;

  return (
    <>
      <PageHeader
        title={data.name}
        subtitle={data.description ?? undefined}
        actions={
          <Button size="sm" variant="ghost" onClick={() => navigate('/projects')}>
            All projects
          </Button>
        }
      />
      <Page>
        <Card className="overflow-hidden">
          <div className="border-b border-border px-4 py-2.5 text-xs font-medium text-muted">
            Tasks
          </div>
          {data.tasks.length === 0 ? (
            <Empty title="No tasks yet" hint="Add tasks from the Todo tab and assign them here." />
          ) : (
            <div className="divide-y divide-border">
              {data.tasks.map((t) => (
                <div key={t.id} className="flex items-center gap-3 px-4 py-2.5">
                  <span
                    className={cn(
                      'size-1.5 shrink-0 rounded-full',
                      t.status === 'done' ? 'bg-positive' : 'bg-border-strong',
                    )}
                  />
                  <span
                    className={cn(
                      'flex-1 truncate text-sm',
                      t.status === 'done' && 'text-faint line-through',
                    )}
                  >
                    {t.title}
                  </span>
                  {t.dueOn && (
                    <span className="text-xs text-muted">
                      <DualDate date={t.dueOn} style="short" />
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      </Page>
    </>
  );
}
