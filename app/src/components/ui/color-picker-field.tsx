/**
 * `ColorPicker`, bound to a form field holding a hex string.
 *
 * Its own item rather than another export of `@cubeui/form`, so a form of plain inputs does not
 * pull in the picker — the split the web `color-field` makes. Named `color-picker-field` because
 * `color-field` is that web-only item, and one name cannot be two items on the web.
 *
 * The label is a `<label htmlFor>` on the hex box, which a `<label>` can name; the swatch row is a
 * `radiogroup`, which it cannot, so the row points back at the label's id by `aria-labelledby`.
 * Both halves of the control are named "Colour" without the caller naming either.
 *
 * ```tsx
 * <form.AppField name="color">
 *   {() => <ColorField label="Colour" swatches={LABEL_COLORS} />}
 * </form.AppField>
 * ```
 */
import type { ComponentProps } from 'react';
import { ColorPicker } from '@/components/ui/color-picker';
import { type FieldProps, FieldWrapper, splitProps, useFieldContext, useFieldIds } from '@/components/ui/form';

type ColorFieldProps = FieldProps &
  Omit<
    ComponentProps<typeof ColorPicker>,
    // Both setters: the picker takes `onChange` and its alias `onValueChange`, and the field
    // supplies the value, so a caller's own would only be overwritten.
    | 'id'
    | 'value'
    | 'onValueChange'
    | 'onChange'
    | 'onBlur'
    | 'className'
    | 'aria-describedby'
    | 'aria-invalid'
    | 'aria-required'
  >;

/** The picker, reading the label's id for its swatch row. Inside the `Field`, where the id is. */
function ColorFieldControl(control: Omit<ColorFieldProps, keyof FieldProps>) {
  const field = useFieldContext<string | null>();
  const { labelId } = useFieldIds();
  return (
    <ColorPicker
      {...control}
      // The row points back at the label unless the caller named it some other way.
      aria-labelledby={
        control['aria-labelledby'] ??
        (control['aria-label'] === undefined && control.swatchesLabel === undefined ? labelId : undefined)
      }
      value={field.state.value ?? ''}
      onChange={(next: string) => {
        field.handleChange(next);
        // Choosing a swatch is the whole interaction, and a swatch press is not a blur of the hex
        // box, so nothing else would tell the field it was touched.
        field.handleBlur();
      }}
      onBlur={field.handleBlur}
    />
  );
}

/** A `ColorPicker` bound to a form field holding a hex colour. */
export function ColorField(props: ColorFieldProps) {
  const [fieldProps, control] = splitProps(props);
  return <FieldWrapper {...fieldProps} controlSlot={<ColorFieldControl {...control} />} />;
}

export type { ColorFieldProps };
