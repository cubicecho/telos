import { useQuery } from '@apollo/client';
import { View } from 'react-native';
import { List } from '@/components/app-icons';
import { ProjectTaskList } from '@/components/domain/project/project-task-list';
import { CardGrid, EmptyState } from '@/components/page';
import { PageLayout } from '@/components/page-layout';
import { LoadState } from '@/components/ui/load-failure';
import { ProjectsDocument } from '@/lib/graphql';

/**
 * Every project at once, each as a list of what is left to do: the overview,
 * where a project's own page is the board. Ticking, adding and editing work
 * here as they do there; lanes, filters and agents stay on the project.
 */
export default function OverviewScreen() {
  const projectsQuery = useQuery(ProjectsDocument);
  const projects = projectsQuery.data?.projects ?? [];

  return (
    <PageLayout
      width="full"
      title="All projects"
      description="Every project's todos, one list each."
      contentSlot={
        <View className="gap-4 px-4 py-6">
          <LoadState
            query={projectsQuery}
            what="your projects"
            count={projects.length}
            emptySlot={
              <EmptyState
                icon={List}
                title="No projects yet"
                description="Make one from the sidebar, and its todos show up here."
              />
            }
          />
          {projects.length > 0 ? (
            <CardGrid contentSlot={projects.map((project) => <ProjectTaskList key={project.id} project={project} />)} />
          ) : null}
        </View>
      }
    />
  );
}
