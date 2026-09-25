import { useQuery } from '@apollo/client';
import { Link, usePathname } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Activity, LogOut } from '@/components/app-icons';
import { useAttentionCount } from '@/components/domain/ai/ai-status';
import { ProjectFormDialog } from '@/components/domain/project/project-form-dialog';
import { Sidebar as SidebarFrame, SidebarNavItem, SidebarSection } from '@/components/sidebar';
import { Button } from '@/components/ui/button';
import { Plus, Settings } from '@/components/ui/icons';
import { LoadState } from '@/components/ui/load-failure';
import { useAi } from '@/lib/ai';
import { clearToken } from '@/lib/auth';
import { ProjectsDocument } from '@/lib/graphql';

/** The persistent shell: every project, always one click away. */
export function Sidebar() {
  const pathname = usePathname();
  const projectsQuery = useQuery(ProjectsDocument);
  const [creating, setCreating] = useState(false);
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
            {ai.on ? (
              <Link href="/stations" asChild>
                <SidebarNavItem
                  href="/stations"
                  label="Stations"
                  icon={<Activity />}
                  count={attention > 0 ? attention : undefined}
                  active={pathname === '/stations'}
                />
              </Link>
            ) : null}
            <Link href="/settings" asChild>
              <SidebarNavItem href="/settings" label="Settings" icon={<Settings />} active={pathname === '/settings'} />
            </Link>
            {/* A button, not a link: it does something rather than going somewhere.
                Drawn like the row above it so the footer reads as one list. */}
            <Pressable
              role="button"
              onPress={signOut}
              className="min-h-8 flex-row items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-sidebar-accent"
            >
              <LogOut className="size-4 text-sidebar-foreground" />
              <Text className="text-sidebar-foreground text-sm">Sign out</Text>
            </Pressable>
          </>
        }
      />
      <ProjectFormDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}
