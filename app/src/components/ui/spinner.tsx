import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Waiting, said out loud as well as drawn.
 *
 * The icon stays `aria-hidden` — a spinning line is nothing to announce — and
 * the wrapper carries the word instead, so a screen reader hears "Loading"
 * rather than the silence every loading screen here used to be. `<output>` for
 * the wrapper because it is already `role="status"` with a polite live region,
 * which is exactly the pair wanted and one fewer attribute to keep true. The
 * label is visually hidden rather than absent: the animation is the sighted
 * half of the same message.
 */
export function Spinner({ className, label = 'Loading' }: { className?: string; label?: string }) {
  return (
    <output className="inline-flex items-center">
      <Loader2 className={cn('h-4 w-4 animate-spin text-muted-foreground', className)} aria-hidden />
      <span className="sr-only">{label}</span>
    </output>
  );
}
