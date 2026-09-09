import { useQuery } from '@apollo/client';
import { Link, usePathname } from 'expo-router';
import { LogOut, Plus, Settings } from 'lucide-react';
import { useState } from 'react';
import { ProjectFormDialog } from '@/components/domain/project/project-form-dialog';
import { ProjectListItem } from '@/components/domain/project/project-list-item';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { clearToken } from '@/lib/auth';
import { ProjectsDocument } from '@/lib/graphql';

/** The persistent shell: every project, always one click away. */
export function Sidebar() {
  const pathname = usePathname();
  const { data, loading } = useQuery(ProjectsDocument);
  const [creating, setCreating] = useState(false);
  const projects = data?.projects ?? [];

  function signOut() {
    clearToken();
    window.location.replace('/login');
  }

  return (
    <aside className="flex h-screen w-64 shrink-0 flex-col border-r bg-card">
      <div className="px-4 pt-4 pb-3">
        <Link href="/" className="font-semibold text-foreground text-lg tracking-tight no-underline">
          Telos
        </Link>
      </div>

      {/* The one action the sidebar offers, so it says what it does rather than
          leaving a bare `+` next to the title for the reader to interpret. */}
      <div className="px-3">
        <Button variant="outline" size="sm" className="w-full gap-2 rounded-full" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" />
          New project
        </Button>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pt-4 pb-2">
        {/* `border-b` rather than a Separator element: the footer below already
            draws its rule this way, and a divider that is part of the block it
            labels cannot drift away from it. It is inset by the nav's own
            padding so it lines up with the project rows, not the sidebar edge. */}
        <p className="mb-1 border-b px-2 pb-2 font-medium text-muted-foreground text-xs uppercase tracking-wide">
          Projects
        </p>
        {loading && projects.length === 0 ? (
          <div className="px-2 py-2">
            <Spinner />
          </div>
        ) : projects.length === 0 ? (
          <p className="px-2 py-2 text-muted-foreground text-sm">No projects yet.</p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {projects.map((project) => (
              <ProjectListItem
                key={project.id}
                id={project.id}
                name={project.name}
                openTodoCount={project.openTodoCount}
                active={pathname === `/projects/${project.id}`}
              />
            ))}
          </div>
        )}
      </nav>

      <div className="flex flex-col gap-0.5 border-t p-2">
        <Link
          href="/settings"
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-muted-foreground text-sm no-underline hover:bg-accent/60 hover:text-accent-foreground"
        >
          <Settings className="h-4 w-4" />
          Settings
        </Link>
        <button
          type="button"
          onClick={signOut}
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-muted-foreground text-sm hover:bg-accent/60 hover:text-accent-foreground"
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </button>
      </div>

      <ProjectFormDialog open={creating} onOpenChange={setCreating} />
    </aside>
  );
}
