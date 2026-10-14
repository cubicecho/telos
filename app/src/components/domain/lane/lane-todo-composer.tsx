import { useState } from 'react';
import { View } from 'react-native';
import { Button } from '@/components/ui/button';
import { Plus } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';

/**
 * Adding a todo straight into an empty column: a button at its foot that turns
 * into a title field, the same inline shape as adding a lane.
 */
export function LaneTodoComposer({ laneName, onCreate }: { laneName: string; onCreate: (title: string) => void }) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');

  function submit() {
    const trimmed = title.trim();
    if (trimmed === '') return;
    setTitle('');
    setAdding(false);
    onCreate(trimmed);
  }

  if (!adding) {
    return (
      <Button
        variant="ghost"
        size="sm"
        onPress={() => setAdding(true)}
        className="justify-start"
        aria-label={`New todo in ${laneName}`}
        iconSlot={<Plus className="mr-1 h-4 w-4" />}
        content="New todo"
      />
    );
  }

  return (
    <View>
      <Input
        autoFocus
        value={title}
        placeholder="Todo title"
        aria-label={`New todo in ${laneName}`}
        onChangeText={setTitle}
        onSubmitEditing={submit}
        // Escape puts the button back; so does blurring an untouched field.
        onEscape={() => {
          setTitle('');
          setAdding(false);
        }}
        onBlur={() => {
          if (title.trim() === '') setAdding(false);
        }}
      />
    </View>
  );
}
