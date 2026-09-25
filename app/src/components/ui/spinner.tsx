import { View } from 'react-native';
import { LoaderCircle } from '@/components/ui/icons';
import { cn } from '@/lib/utils';

/**
 * Waiting, said out loud as well as drawn.
 *
 * The icon stays `aria-hidden` — a spinning line is nothing to announce — and
 * the wrapper carries the word instead, so a screen reader hears "Loading"
 * rather than silence. `role="status"` is the polite live region `<output>`
 * used to give for free; a `View` has no `<output>` to become, so the role and
 * the name are spelled out, the same way cubeui's `RowSkeleton` does it.
 */
export function Spinner({ className, label = 'Loading' }: { className?: string; label?: string }) {
  return (
    <View role="status" aria-label={label} className="flex-row items-center">
      <LoaderCircle className={cn('h-4 w-4 animate-spin text-muted-foreground', className)} aria-hidden />
    </View>
  );
}
