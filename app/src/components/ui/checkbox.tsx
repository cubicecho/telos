import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { Check } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

/**
 * A square box, not a circle: `rounded-[4px]` is the shape cubeui settled on, and
 * at 20px a circle reads as a status dot rather than as something to click.
 *
 * Hovering an unchecked box shows the tick it would get. Radix renders its own
 * Indicator only once checked, so the preview is a second icon, hidden by
 * `data-state` and by `data-disabled` — a blocked todo must not offer a tick it
 * will refuse. Every hover rule is scoped to one `data-state`, so the checked and
 * unchecked styles never race in the cascade.
 */
export function Checkbox({ className, ...props }: ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      className={cn(
        'group/checkbox peer relative flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px] border',
        'border-muted-foreground/40 ring-offset-background transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        'disabled:cursor-not-allowed disabled:opacity-40',
        'data-[state=unchecked]:enabled:hover:border-primary data-[state=unchecked]:enabled:hover:bg-accent',
        'data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground',
        'data-[state=checked]:enabled:hover:bg-primary/90',
        className,
      )}
      {...props}
    >
      <Check
        aria-hidden
        strokeWidth={3}
        className={cn(
          'pointer-events-none absolute inset-0 m-auto h-3.5 w-3.5 text-primary opacity-0 transition-opacity',
          'group-hover/checkbox:opacity-60',
          'group-data-[state=checked]/checkbox:hidden group-data-[disabled]/checkbox:hidden',
        )}
      />
      <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
        <Check className="h-3.5 w-3.5" strokeWidth={3} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
