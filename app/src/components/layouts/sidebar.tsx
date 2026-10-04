import { useQuery } from '@apollo/client';
import { Link, usePathname } from 'expo-router';
import { useCallback, useState } from 'react';
import { Platform, Text, View } from 'react-native';
import { Activity, History, LogOut } from '@/components/app-icons';
import { useAttentionCount } from '@/components/domain/ai/ai-status';
import { ProjectFormDialog } from '@/components/domain/project/project-form-dialog';
import { TodoSearch, useSearchShortcut } from '@/components/domain/todo/todo-search';
import { Sidebar as SidebarFrame, SidebarNavItem, SidebarSection } from '@/components/sidebar';
import { Button } from '@/components/ui/button';
import { Plus, Search, Settings } from '@/components/ui/icons';
import { LoadState } from '@/components/ui/load-failure';
import { useAi } from '@/lib/ai';
import { clearToken } from '@/lib/auth';
import { ProjectsDocument } from '@/lib/graphql';

/** The persistent shell: every project, always one click away. */
export function Sidebar() {
  const pathname = usePathname();
  const projectsQuery = useQuery(ProjectsDocument);
  const [creating, setCreating] = useState(false);
  const [searching, setSearching] = useState(false);
  useSearchShortcut(useCallback(() => setSearching(true), []));
  const projects = projectsQuery.data?.projects ?? [];
  const ai = useAi();
  const attention = useAttentionCount();

  function signOut() {
    clearToken();
    window.location.replace('/login');
  }

  return (
    <>
      <SidebarFrame
        label="Telos"
        header={
          <>
            <Link href="/" className="px-1 font-semibold text-foreground text-lg tracking-tight no-underline">
              Telos
            </Link>
            {/* The one action the sidebar offers, so it says what it does rather
                than leaving a bare `+` for the reader to interpret, and it wears
                `primary`. Nothing else in the sidebar is filled, so the colour is
                the whole hierarchy: spend it on the action and the rows stay quiet. */}
            <Button size="sm" className="w-full gap-2 rounded-lg" onPress={() => setCreating(true)}>
              <Plus className="h-4 w-4" />
              New project
            </Button>
          </>
        }
        content={
          <View role="navigation" aria-label="Projects">
            <SidebarSection
              title="Projects"
              status={
                /* Only when there is nothing to show. A refetch that fails while the
                   last good list is still on screen leaves it there — the rail is how
                   you get anywhere, and replacing it with an apology would strand the
                   reader on whatever page they are already on. */
                <LoadState
                  query={projectsQuery}
                  what="your projects"
                  count={projects.length}
                  compact
                  empty={<Text className="px-2 py-2 text-muted-foreground text-sm">No projects yet.</Text>}
                />
              }
              content={projects.map((project) => (
                <Link key={project.id} href={`/projects/${project.id}`} asChild>
                  <SidebarNavItem
                    href={`/projects/${project.id}`}
                    label={project.name}
                    count={project.openTodoCount > 0 ? project.openTodoCount : undefined}
                    active={pathname === `/projects/${project.id}`}
                  />
                </Link>
              ))}
            />
          </View>
        }
        footer={
          <>
            <SidebarNavItem
              label="Search"
              icon={<Search />}
              // The shortcut is a web keyboard's; on device there is none to show.
              count={Platform.OS === 'web' ? 'Ctrl K' : undefined}
              aria-label="Search todos"
              onPress={() => setSearching(true)}
            />
            {ai.on ? (
              <Link href="/agents" asChild>
                <SidebarNavItem
                  href="/agents"
                  label="Agents"
                  icon={<Activity />}
                  count={attention > 0 ? attention : undefined}
                  active={pathname === '/agents'}
                />
              </Link>
            ) : null}
            {ai.on ? (
              <Link href="/activity" asChild>
                <SidebarNavItem
                  href="/activity"
                  label="Activity"
                  icon={<History />}
                  active={pathname === '/activity'}
                />
              </Link>
            ) : null}
            <Link href="/settings" asChild>
              <SidebarNavItem href="/settings" label="Settings" icon={<Settings />} active={pathname === '/settings'} />
            </Link>
            {/* A button, not a link: it does something rather than going somewhere. */}
            <SidebarNavItem label="Sign out" icon={<LogOut />} onPress={signOut} />
          </>
        }
      />
      <ProjectFormDialog open={creating} onOpenChange={setCreating} />
      <TodoSearch open={searching} onOpenChange={setSearching} />
    </>
  );
}
