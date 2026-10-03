import { useState } from 'react';
import { View } from 'react-native';
import { Button } from '@/components/ui/button';
import { Plus } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';

/**
 * Adding a column, in the column's own place at the end of the board — the same
 * inline shape as adding a todo, for the same reason: a name and Enter.
 */
export function LaneComposer({ onCreate }: { onCreate: (name: string) => Promise<void> }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');

  async function submit() {
    const trimmed = name.trim();
    if (trimmed === '') return;
    setName('');
    setAdding(false);
    await onCreate(trimmed);
  }

  if (!adding) {
    return (
      <Button variant="ghost" onPress={() => setAdding(true)} className="h-9 w-72 shrink-0 justify-start">
        <Plus className="mr-1 h-4 w-4" />
        Add lane
      </Button>
    );
  }

  return (
    <View className="w-72 shrink-0">
      <Input
        autoFocus
        value={name}
        placeholder="Lane name"
        aria-label="New lane"
        onChangeText={setName}
        onSubmitEditing={submit}
        // Escape puts the button back rather than leaving an empty field on the
        // board; blurring an untouched field does the same.
        onEscape={() => setAdding(false)}
        onBlur={() => {
          if (name.trim() === '') setAdding(false);
        }}
      />
    </View>
  );
}
