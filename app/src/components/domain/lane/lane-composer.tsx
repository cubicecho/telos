import { Plus } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * Adding a column, in the column's own place at the end of the board — the same
 * inline shape as adding a todo, for the same reason: a name and Enter.
 */
export function LaneComposer({ onCreate }: { onCreate: (name: string) => Promise<void> }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed === '') return;
    setName('');
    setAdding(false);
    await onCreate(trimmed);
  }

  if (!adding) {
    return (
      <Button
        variant="ghost"
        onClick={() => setAdding(true)}
        className="h-9 w-72 shrink-0 justify-start text-muted-foreground"
      >
        <Plus className="mr-1 h-4 w-4" />
        Add lane
      </Button>
    );
  }

  return (
    <form onSubmit={onSubmit} className="w-72 shrink-0">
      <Input
        autoFocus
        value={name}
        placeholder="Lane name"
        aria-label="New lane"
        onChange={(event) => setName(event.target.value)}
        // Escape puts the button back rather than leaving an empty field on the
        // board; blurring an untouched field does the same.
        onKeyDown={(event) => {
          if (event.key === 'Escape') setAdding(false);
        }}
        onBlur={() => {
          if (name.trim() === '') setAdding(false);
        }}
      />
    </form>
  );
}
