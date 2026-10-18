/**
 * The native label: just text. `htmlFor` is accepted and ignored — there is no
 * label/control association on native, and a `TextInput` is focused by tapping
 * it rather than its caption.
 */

import { Text } from 'react-native';
import { LABEL_CLASS, type LabelProps } from '@/components/ui/label-base';
import { cn } from '@/lib/utils';

/** The caption that names a control. */
function Label({ className, id, children }: LabelProps) {
  return (
    <Text id={id} className={cn(LABEL_CLASS, className)}>
      {children}
    </Text>
  );
}

export { Label };
