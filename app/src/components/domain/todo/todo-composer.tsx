import { forwardRef, useState } from 'react';
import { Text, View } from 'react-native';
import { Button } from '@/components/ui/button';
import { Plus } from '@/components/ui/icons';
import type { InputHandle } from '@/components/ui/input';
import { Input } from '@/components/ui/input';
import type { CachedLane } from '@/lib/cache';
import { describeError } from '@/lib/errors';
import { useCreateTodo } from './use-create-todo';

/**
 * Adding a todo is a title and nothing else, so it is an inline field rather
 * than a dialog — the cost of capturing one should be a sentence and Enter.
 *
 * And it should cost no waiting either: `useCreateTodo` writes the row to the
 * cache before the request leaves, so the only state this has to undo by hand
 * is the emptied field.
 *
 * The ref goes to the field, so `n` can focus it from anywhere on the screen.
 * It is cubeui's `InputHandle` rather than the DOM element: `focus()` is all
 * the hotkey needs, and it is the part both platforms can promise.
 */
export const TodoComposer = forwardRef<
  InputHandle,
  {
    projectId: string;
    nextPosition: number;
    lanes: readonly CachedLane[];
  }
>(function TodoComposer({ projectId, nextPosition, lanes }, ref) {
  const [title, setTitle] = useState('');
  const { create, error } = useCreateTodo(projectId, lanes);

  async function onSubmit() {
    const trimmed = title.trim();
    if (trimmed === '') return;

    // Cleared now rather than after the round trip, so the next todo can be
    // typed immediately. Put back below if the write turns out to have failed.
    setTitle('');

    try {
      await create(trimmed, nextPosition);
    } catch {
      // The message is already on screen via `error`; this hands back what was
      // typed so it does not have to be typed again.
      setTitle(trimmed);
    }
  }

  return (
    <View className="gap-1">
      <View className="flex-row gap-2">
        {/* Enter submits through `onSubmitEditing`: there is no `<form>` here,
            which is the one shape both platforms agree on. */}
        <Input
          ref={ref}
          // Named without a visible label: the placeholder already says it.
          aria-label="New todo"
          value={title}
          placeholder="Add a todo…  (press n)"
          onChangeText={setTitle}
          onSubmitEditing={onSubmit}
          className="flex-1"
        />
        {/* Not disabled while the write is in flight: the row is already on the
            list and the field is already empty, so the only thing waiting on the
            server would be the next todo. An empty field is what stops a
            double-submit. */}
        <Button
          variant="positive"
          onPress={onSubmit}
          disabled={title.trim() === ''}
          iconSlot={<Plus className="mr-1 h-4 w-4" />}
          content="Add"
        />
      </View>
      {error ? (
        <Text className="text-negative text-sm" aria-live="polite">
          {describeError(error)}
        </Text>
      ) : null}
    </View>
  );
});
