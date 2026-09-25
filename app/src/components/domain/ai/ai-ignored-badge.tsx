import { Badge } from '@/components/ui/badge';
import { useAi } from '@/lib/ai';

/**
 * "AI ignores this", on a row or a card. It looks like a tag but is a column
 * (`todos.aiIgnored`), so renaming or deleting a label can never quietly hand
 * a todo back to the agents. Drawn only while AI is on: off, the flag means
 * nothing and says nothing.
 */
export function AiIgnoredBadge({ ignored, className }: { ignored: boolean; className?: string }) {
  const ai = useAi();
  if (!ai.on || !ignored) return null;
  return (
    <Badge variant="outline" className={className}>
      AI ignores this
    </Badge>
  );
}
