/**
 * The native checkbox, built from a `Pressable`. `checkbox.web.tsx` is radix's, and
 * `checkbox-base.ts` holds the contract they share.
 *
 * `role="checkbox"` plus `aria-checked` is what makes it a real checkbox to a
 * screen reader; the role and `aria-checked` below are the part that actually
 * matters, and they cost nothing.
 */

import { useState } from 'react';
import { Pressable } from 'react-native';
import { CHECKBOX_CLASS, type CheckboxProps } from '@/components/ui/checkbox-base';
import { Check } from '@/components/ui/icons';
import { cn } from '@/lib/utils';

/** A box that is checked or not. */
function Checkbox({
  checked: checkedProp,
  defaultChecked = false,
  onCheckedChange,
  disabled = false,
  onBlur,
  accessibilityLabel,
  className,
}: CheckboxProps) {
  // Controlled when `checked` is passed and self-driving otherwise, the way radix's is.
  const [checkedState, setCheckedState] = useState(defaultChecked);
  const checked = checkedProp ?? checkedState;
  return (
    <Pressable
      role="checkbox"
      aria-checked={checked}
      aria-label={accessibilityLabel}
      disabled={disabled}
      onPress={() => {
        setCheckedState(!checked);
        onCheckedChange?.(!checked);
      }}
      onBlur={onBlur}
      className={cn(
        CHECKBOX_CLASS,
        checked ? 'border-active bg-active' : 'border-foreground/50 bg-background',
        disabled && 'opacity-50',
        className,
      )}
    >
      {checked && <Check className="h-3 w-3 text-active-foreground" />}
    </Pressable>
  );
}

export type { CheckboxProps };
export { Checkbox };
