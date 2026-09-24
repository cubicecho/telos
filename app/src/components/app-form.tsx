import { createFormHook } from '@tanstack/react-form';
import { type ComponentProps, type ReactNode, useId } from 'react';
import { ColorPicker } from '@/components/ui/color-picker';
import { DateTimeInput } from '@/components/ui/date-time-input';
import {
  Field,
  FieldControl,
  FieldDescription,
  FieldError,
  FieldLabel,
  fieldContext,
  formContext,
  InputField,
  SelectField,
  SubmitButton,
  TextAreaField,
  useFieldContext,
} from '@/components/ui/form';

/**
 * The app's form hook: cubeui's native `Form` fields, registered once.
 *
 * Local patch until cubicecho/cubeui#115. The native item ships the contexts
 * and the fields but no `useAppForm`, and no bound field for the date or the
 * colour control, so both are written here from its own parts. Each names its
 * control by reference — `aria-labelledby` at the label's id — rather than by
 * `htmlFor` alone, which is what `DateTimeInput` needs to keep the picked date
 * in its name and what a swatch `radiogroup` needs to be named at all.
 */

/** Always the clearable form: the field holds `Date | null`, and null is a value it can be set to. */
type DateFieldProps = {
  label: string;
  description?: ReactNode;
  mode?: 'date' | 'datetime';
  placeholder?: string;
  className?: string;
};

function DateField({ label, description, ...props }: DateFieldProps) {
  const field = useFieldContext<Date | null>();
  const labelId = useId();
  return (
    <Field>
      {/* No `htmlFor`: a label pointed at the trigger names it "Due" and drops the date. */}
      <FieldLabel id={labelId} htmlFor={undefined}>
        {label}
      </FieldLabel>
      <DateTimeInput
        {...props}
        clearable
        aria-labelledby={labelId}
        value={field.state.value}
        onChange={(value) => {
          field.handleChange(value);
          field.handleBlur();
        }}
      />
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      <FieldError />
    </Field>
  );
}

type ColorFieldProps = {
  label: string;
} & Omit<ComponentProps<typeof ColorPicker>, 'value' | 'onChange' | 'onValueChange' | 'onBlur' | 'aria-labelledby'>;

function ColorField({ label, hexLabel = `${label} hex`, ...props }: ColorFieldProps) {
  const field = useFieldContext<string>();
  const labelId = useId();
  return (
    <Field>
      {/* Named by reference, which reaches the swatch row no `<label>` can.
          No `htmlFor`: it would also name the hex box "Colour", two controls
          under one name. The box takes `hexLabel` instead: "Colour hex". */}
      <FieldLabel id={labelId} htmlFor={undefined}>
        {label}
      </FieldLabel>
      <FieldControl>
        <ColorPicker
          {...props}
          hexLabel={hexLabel}
          aria-labelledby={labelId}
          value={field.state.value}
          onValueChange={field.handleChange}
          onBlur={field.handleBlur}
        />
      </FieldControl>
      <FieldError />
    </Field>
  );
}

export const { useAppForm } = createFormHook({
  fieldContext,
  formContext,
  fieldComponents: { InputField, TextAreaField, SelectField, DateField, ColorField },
  formComponents: { SubmitButton },
});
