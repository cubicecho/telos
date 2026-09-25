import { useQuery } from '@apollo/client';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
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
  const [active, setActive] = useState(0);
  const [picked, setPicked] = useState<Found | null>(null);

  useEffect(() => {
    if (!open) return;
    setText('');
    setAsked('');
    setActive(0);
  }, [open]);

  useEffect(() => {
    const timer = setTimeout(() => setAsked(text.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const query = useQuery(SearchTodosDocument, { variables: { text: asked }, skip: !open || asked === '' });
  // The last answer stays up while the next is on its way, so the list does not blink per keystroke.
  const found: readonly Found[] = asked === '' ? [] : (query.data?.todos ?? query.previousData?.todos ?? []);

  useEffect(() => {
    setActive((at) => Math.min(at, Math.max(found.length - 1, 0)));
  }, [found.length]);

  function pick(todo: Found | undefined) {
    if (!todo) return;
    onOpenChange(false);
    setPicked(todo);
    if (todo.project) router.push(`/projects/${todo.project.id}`);
  }

  // Up and down move through the results while the field keeps focus; Enter
  // is the field's own submit.
  useEffect(() => {
    if (!open || Platform.OS !== 'web') return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((at) => (found.length === 0 ? 0 : (at + step + found.length) % found.length));
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, found.length]);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="gap-3 sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Find a todo</DialogTitle>
            <DialogDescription>By title or notes, in every project.</DialogDescription>
          </DialogHeader>
          <Input
            type="search"
            autoFocus
            value={text}
            onChangeText={(next) => {
              setText(next);
              setActive(0);
            }}
            onSubmitEditing={() => pick(found[active])}
            placeholder="Search todos"
            aria-label="Search todos"
          />
          {asked === '' ? null : (
            <LoadState
              query={query}
              what="todos"
              count={found.length}
              empty={<Text className="text-muted-foreground text-sm">Nothing matches “{asked}”.</Text>}
            />
          )}
          {found.length === 0 ? null : (
            // No `listbox` in react-native's roles: a menu of items is the nearest it has.
            <View role="menu" aria-label="Todos found" className="max-h-96 gap-0.5 overflow-auto">
              {found.map((todo, at) => (
                <Pressable
                  key={todo.id}
                  role="menuitem"
                  aria-selected={at === active}
                  onPress={() => pick(todo)}
                  onHoverIn={() => setActive(at)}
                  className={cn('rounded-md px-3 py-2', at === active && 'bg-accent')}
                >
                  <Text
                    numberOfLines={1}
                    className={cn('text-foreground text-sm', todo.completedAt && 'text-muted-foreground line-through')}
                  >
                    {todo.title}
                  </Text>
                  <Text numberOfLines={1} className="text-muted-foreground text-xs">
                    {todo.project?.name ?? 'No project'}
                    {todo.lane ? ` · ${todo.lane.name}` : ''}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}
        </DialogContent>
      </Dialog>
      {picked ? (
        <TodoFormDialog key={picked.id} open onOpenChange={(next) => !next && setPicked(null)} todo={picked} />
      ) : null}
    </>
  );
}
