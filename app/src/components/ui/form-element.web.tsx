/**
 * The element `<Form>` renders on web: a real `<form>`.
 *
 * Kept for one reason — Enter inside a field raises the DOM submit event, and
 * nothing else in the tree does. `SubmitButton` is a `Pressable`, not a submit
 * control, so the two paths cannot both fire for one press.
 */
import type { FormElementProps } from '@/components/ui/form-element-base';
import { cn } from '@/lib/utils';

/** The element a form renders as: a `<form>` on the web, a `View` on device. */
export function FormElement({ onSubmit, id, className, children }: FormElementProps) {
  return (
    <form
      id={id}
      className={cn('flex flex-col', className)}
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onSubmit();
      }}
    >
      {children}
    </form>
  );
}
