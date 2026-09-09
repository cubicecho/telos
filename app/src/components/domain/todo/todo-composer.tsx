import { useMutation } from '@apollo/client';
import { Plus } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CreateTodoDocument, ProjectDocument, ProjectsDocument, ProjectTodosDocument } from '@/lib/graphql';

/**
 * Adding a todo is a title and nothing else, so it is an inline field rather
 * than a dialog — the cost of capturing one should be a sentence and Enter.
 */
export function TodoComposer({ projectId, nextPosition }: { projectId: string; nextPosition: number }) {
  const [title, setTitle] = useState('');
  const [createTodo, { loading, error }] = useMutation(CreateTodoDocument, {
    refetchQueries: [
      { query: ProjectTodosDocument, variables: { projectId } },
      { query: ProjectDocument, variables: { id: projectId } },
      ProjectsDocument,
    ],
  });

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = title.trim();
    if (trimmed === '') return;
    await createTodo({ variables: { values: { projectId, title: trimmed, position: nextPosition } } });
    setTitle('');
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-1">
      <div className="flex gap-2">
        <Input
          value={title}
          placeholder="Add a todo…"
          onChange={(event) => setTitle(event.target.value)}
          aria-label="New todo"
        />
        <Button type="submit" disabled={loading || title.trim() === ''}>
          <Plus className="mr-1 h-4 w-4" />
          Add
        </Button>
      </div>
      {error ? <p className="text-destructive text-sm">{error.message}</p> : null}
    </form>
  );
}
