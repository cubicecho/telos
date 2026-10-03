import { PasswordInput, type PasswordInputProps } from '@/components/password-input';
import { ColorField } from '@/components/ui/color-picker-field';
import { DateTimeField } from '@/components/ui/date-time-field';
import { createAppForm, FieldWrapper, useFieldContext } from '@/components/ui/form';

type PasswordFieldProps = { label: string } & Omit<PasswordInputProps, 'value' | 'onChangeText' | 'onBlur'>;

/**
 * A secret, as cubeui's `PasswordInput` with its reveal button, bound the way
 * `InputField` is. cubeui ships the input but no field for it.
 */
function PasswordField({ label, ...props }: PasswordFieldProps) {
  const field = useFieldContext<string>();
  return (
    <FieldWrapper
      label={label}
      control={
        <PasswordInput
          // "Show API key", not "Show password": none of these is a password.
          showLabel={`Show ${label}`}
          hideLabel={`Hide ${label}`}
          {...props}
          value={field.state.value ?? ''}
          onBlur={field.handleBlur}
          onChangeText={field.handleChange}
        />
      }
    />
  );
}

/**
 * The app's form hook: cubeui's native fields, with the two heavy ones — the
 * calendar and the colour picker — joined to them once, here, so every dialog
 * reaches all of them on `field.*`, along with a password field.
 */
export const { useAppForm, withForm } = createAppForm({ DateTimeField, ColorField, PasswordField });
