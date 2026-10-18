/**
 * The web label: radix, which is here for one thing — clicking the label
 * focuses the control named by `htmlFor`. That association has no native
 * counterpart, which is the whole reason for the split.
 *
 * It takes radix's `Label.Root` props whole — `id`, `onClick`, the `aria-*`
 * and `data-*` props — because it installs over a DOM app's shadcn label, and
 * shadcn's `FieldLabel` is typed as this label's props.
 */

import { Label as LabelPrimitive } from 'radix-ui';
import type { ComponentPropsWithRef } from 'react';
import { LABEL_CLASS } from '@/components/ui/label-base';
import { cn } from '@/lib/utils';

type LabelProps = Omit<ComponentPropsWithRef<typeof LabelPrimitive.Root>, 'className'> & {
  className?: string | undefined;
};

/** The caption that names a control. */
function Label({ className, ...props }: LabelProps) {
  return <LabelPrimitive.Root data-slot="label" {...props} className={cn(LABEL_CLASS, className)} />;
}

export { Label };
