import { Link } from 'expo-router';
import { cn } from '@/lib/utils';

export function ProjectListItem({
  id,
  name,
  openTodoCount,
  active,
}: {
  id: string;
  name: string;
  openTodoCount: number;
  active: boolean;
}) {
  return (
    <Link
      href={`/projects/${id}`}
      className={cn(
        'flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm no-underline transition-colors',
        active ? 'bg-accent font-medium text-accent-foreground' : 'text-foreground hover:bg-accent/60',
      )}
    >
      <span className="truncate">{name}</span>
      {openTodoCount > 0 ? (
        <span className="shrink-0 tabular-nums text-muted-foreground text-xs">{openTodoCount}</span>
      ) : null}
    </Link>
  );
}
