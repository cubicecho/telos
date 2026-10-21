import { useQuery } from '@apollo/client';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform, Text } from 'react-native';
import { CommandDialog, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { LoadState } from '@/components/ui/load-failure';
import { SearchTodosDocument } from '@/lib/graphql';
import { cn } from '@/lib/utils';
import { TodoFormDialog } from './todo-form-dialog';
import type { TodoSummary } from './types';

/** How long typing must pause before the search goes out. */
const DEBOUNCE_MS = 200;

type Found = TodoSummary & { project: { id: string; name: string } | null };

/**
 * Ctrl+K (⌘K on a Mac) from anywhere: a search across every project's todos,
 * by title and notes. Picking one goes to its project and opens it, so the
 * dialog lands in context rather than floating over whatever was showing.
 *
 * The shortcut is web's; the sidebar's "Search" row opens it everywhere.
 */
export function useSearchShortcut(open: () => void) {
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    function onKey(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        open();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
}

export function TodoSearch({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const [text, setText] = useState('');
  const [asked, setAsked] = useState('');
  const [picked, setPicked] = useState<Found | null>(null);

  useEffect(() => {
    if (!open) return;
    setText('');
    setAsked('');
  }, [open]);

  useEffect(() => {
    const timer = setTimeout(() => setAsked(text.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const query = useQuery(SearchTodosDocument, { variables: { text: asked }, skip: !open || asked === '' });
  // The last answer stays up while the next is on its way, so the list does not blink per keystroke.
  const found: readonly Found[] = asked === '' ? [] : (query.data?.todos ?? query.previousData?.todos ?? []);

  function pick(todo: Found) {
    onOpenChange(false);
    setPicked(todo);
    if (todo.project) router.push(`/projects/${todo.project.id}`);
  }

  return (
    <>
      {/* A palette: the search row runs edge to edge, so the dialog is named rather than titled.
          The server has already matched title and notes, so the list is drawn as it came back
          rather than filtered again by the words as typed. */}
      <CommandDialog
        open={open}
        onOpenChange={onOpenChange}
        title="Find a todo"
        description="By title or description, in every project."
        label="Search todos"
        shouldFilter={false}
        className="sm:max-w-xl"
      >
        <CommandInput
          autoFocus
          value={text}
          onValueChange={setText}
          placeholder="Find a todo by title or description"
        />
        {asked === '' ? null : (
          <LoadState
            query={query}
            what="todos"
            count={found.length}
            className="px-3 py-2"
            emptySlot={<Text className="text-foreground/60 text-sm">Nothing matches “{asked}”.</Text>}
          />
        )}
        {found.length === 0 ? null : (
          <CommandList label="Todos found" className="max-h-96">
            {found.map((todo) => (
              <CommandItem
                key={todo.id}
                value={todo.id}
                onSelect={() => pick(todo)}
                className="flex-col items-start gap-0 px-3 py-2"
              >
                <Text
                  numberOfLines={1}
                  className={cn('text-foreground text-sm', todo.completedAt && 'text-foreground/60 line-through')}
                >
                  {todo.title}
                </Text>
                <Text numberOfLines={1} className="text-foreground/60 text-xs">
                  {todo.project?.name ?? 'No project'}
                  {todo.lane ? ` · ${todo.lane.name}` : ''}
                </Text>
              </CommandItem>
            ))}
          </CommandList>
        )}
      </CommandDialog>
      {picked ? (
        <TodoFormDialog key={picked.id} open onOpenChange={(next) => !next && setPicked(null)} todo={picked} />
      ) : null}
    </>
  );
}
