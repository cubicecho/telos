import { createFormHookContexts, useStore } from '@tanstack/react-form';
import { Slot } from 'radix-ui';
import type { ReactNode } from 'react';
import * as React from 'react';
import { View } from 'react-native';
import { Button } from '@/components/ui/button';
import {
  FieldDescription as FieldDescriptionPrimitive,
  FieldError as FieldErrorPrimitive,
  FieldLabel as FieldLabelPrimitive,
  Field as FieldPrimitive,
} from '@/components/ui/field';
import { FormElement } from '@/components/ui/form-element';
import type { FormElementProps } from '@/components/ui/form-element-base';
import { Input } from '@/components/ui/input';
import type { InputProps } from '@/components/ui/input-base';
import type { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { TextareaProps } from '@/components/ui/textarea-base';
import { cn } from '@/lib/utils';

export const { fieldContext, formContext, useFieldContext, useFormContext } = createFormHookContexts();

/** Per-field unique ID, so the three `id`s below are derived rather than passed. */
const IdContext = React.createContext<string | null>(null);

function useFieldComponentContext() {
  const field = useFieldContext();
  const id = React.useContext(IdContext);

  if (!id) throw new Error('Form field components must be used within <Field>');

  const errors = useStore(field.store, (s) => s.meta.errors);
  const isTouched = useStore(field.store, (s) => s.meta.isTouched);
  const submissionAttempts = useStore(field.form.store, (s) => s.submissionAttempts);

  return React.useMemo(() => {
    // Nothing is shown as wrong until the user has been in the field or has
    // tried to submit — otherwise an empty required field is red on first paint.
    const showError = isTouched || submissionAttempts > 0;
    let errorMessage: string | null = null;

    if (showError && errors.length > 0) {
      // A validator may yield a string, a `{ message }`, or something else
      // entirely — a standard-schema issue, a thrown value. Narrow, then fall
      // back to `String`, because showing the wrong text beats showing none.
      const err = errors[0];
      if (typeof err === 'string') errorMessage = err;
      else if (err && typeof err === 'object' && 'message' in err)
        errorMessage = String((err as { message: unknown }).message);
      else if (err != null) errorMessage = String(err);
    }

    return {
      controlId: `${id}-control`,
      descriptionId: `${id}-description`,
      messageId: `${id}-message`,
      error: errorMessage,
      hasError: showError && errorMessage !== null,
    };
  }, [id, isTouched, submissionAttempts, errors]);
}

/**
 * The form body. On web this is a real `<form>` so Enter inside a field still
 * submits; on native it is a `View` and `SubmitButton` is the only path to
 * submission. Either way the submit is routed through form context.
 */
function Form({ className, children }: Omit<FormElementProps, 'onSubmit'>) {
  const form = useFormContext();
  return (
    <FormElement
      onSubmit={() => {
        form.handleSubmit();
      }}
      className={className}
    >
      {children}
    </FormElement>
  );
}

/**
 * Provides the ID context the rest of the field reads.
 *
 * The web original also set `data-invalid` here for a `group-data-[…]/field:`
 * variant. Both are DOM-only, and the invalid state that matters is already on
 * the control itself as `aria-invalid` — which is what a screen reader reads.
 */
function Field(props: React.ComponentProps<typeof FieldPrimitive>) {
  const uid = React.useId();
  return (
    <IdContext.Provider value={uid}>
      <FieldPrimitive {...props} />
    </IdContext.Provider>
  );
}

/** Auto-wires `htmlFor` to the control's derived id. */
function FieldLabel({ ...props }: React.ComponentProps<typeof Label>) {
  const { controlId } = useFieldComponentContext();
  return <FieldLabelPrimitive htmlFor={controlId} {...props} />;
}

/**
 * Passes the id and the aria wiring down to whatever control is inside, without
 * rendering an element of its own — so any control can be bound, including one
 * this file knows nothing about.
 *
 * radix's `Slot` is used on both platforms. It only clones its child with merged
 * props; there is no DOM in it, so it works under React Native unchanged.
 */
function FieldControl({ ...props }: React.ComponentProps<typeof Slot.Root>) {
  const { controlId, descriptionId, messageId, hasError } = useFieldComponentContext();
  const describedBy = [descriptionId, hasError ? messageId : null].filter(Boolean).join(' ');
  return (
    <Slot.Root
      id={controlId}
      aria-describedby={describedBy || undefined}
      aria-invalid={hasError || undefined}
      {...props}
    />
  );
}

function FieldDescription({ ...props }: React.ComponentProps<typeof FieldDescriptionPrimitive>) {
  const { descriptionId } = useFieldComponentContext();
  return <FieldDescriptionPrimitive id={descriptionId} {...props} />;
}

function FieldError({ ...props }: React.ComponentProps<typeof FieldErrorPrimitive>) {
  const { error, messageId } = useFieldComponentContext();
  if (!error) return null;
  return (
    <FieldErrorPrimitive id={messageId} {...props}>
      {error}
    </FieldErrorPrimitive>
  );
}

/**
 * Fields side by side, two to a row — what `grid grid-cols-2 gap-4` did on web.
 * `grid` has no native equivalent, and the `flex-1` has to sit on each cell
 * rather than on the field, which would then only be laid out correctly inside
 * a row. `min-w-[45%]` is what makes a third field wrap instead of squeezing.
 */
function FieldRow({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <View className={cn('flex-row flex-wrap gap-4', className)}>
      {React.Children.map(children, (child) =>
        child == null || child === false ? null : <View className="min-w-[45%] flex-1">{child}</View>,
      )}
    </View>
  );
}

type FieldWrapperProps = {
  label: ReactNode;
  control: ReactNode;
};

/** Label, control, error — the shape every bound field below is built from. */
function FieldWrapper({ label, control }: FieldWrapperProps) {
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <FieldControl>{control}</FieldControl>
      <FieldError />
    </Field>
  );
}

type InputFieldProps = {
  label: string;
} & Omit<InputProps, 'value' | 'onChangeText' | 'onBlur'>;

function InputField({ label, ...props }: InputFieldProps) {
  // The stored value is whatever the schema says — string, number or null — and
  // this component is generic over all of them, so there is nothing narrower to
  // write here. Both edges are handled explicitly: `String(… ?? "")` going in,
  // and the `type === "number"` branch coming out.
  // biome-ignore lint/suspicious/noExplicitAny: see above
  const field = useFieldContext<any>();

  return (
    <FieldWrapper
      label={label}
      control={
        <Input
          {...props}
          value={String(field.state.value ?? '')}
          onBlur={field.handleBlur}
          onChangeText={(text) => {
            if (props.type === 'number') {
              // `valueAsNumber` is DOM-only; parse the text so native agrees.
              field.handleChange(text === '' ? null : Number(text));
            } else {
              field.handleChange(text);
            }
          }}
        />
      }
    />
  );
}

type TextAreaFieldProps = {
  label: string;
} & Omit<TextareaProps, 'value' | 'onChangeText' | 'onBlur'>;

function TextAreaField({ label, ...props }: TextAreaFieldProps) {
  const field = useFieldContext<string>();

  return (
    <FieldWrapper
      label={label}
      control={
        <Textarea
          {...props}
          value={field.state.value ?? ''}
          onBlur={field.handleBlur}
          onChangeText={(text) => field.handleChange(text)}
        />
      }
    />
  );
}

type SelectOption = {
  label: string;
  value: string;
};

type SelectFieldProps = {
  label: string;
  options: readonly SelectOption[];
  placeholder?: string;
};

function SelectField({ label, options, placeholder }: SelectFieldProps) {
  const field = useFieldContext<string>();

  return (
    <FieldWrapper
      label={label}
      control={
        <Select value={field.state.value} onValueChange={(v) => field.handleChange(v)}>
          <SelectTrigger onBlur={field.handleBlur}>
            <SelectValue placeholder={placeholder} />
          </SelectTrigger>
          <SelectContent>
            {options.map(({ label: optionLabel, value }) => (
              <SelectItem key={value} value={value}>
                {optionLabel}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    />
  );
}

type SubmitButtonProps = {
  isEdit?: boolean;
  createLabel?: string;
  editLabel?: string;
  savingLabel?: string;
  /** Leading glyph, e.g. `<Plus className="mr-1 h-4 w-4" />`. */
  icon?: React.ReactNode;
} & Omit<React.ComponentProps<typeof Button>, 'disabled' | 'children'>;

/**
 * The submit control: reads `canSubmit` / `isSubmitting` from form context, so
 * every form guards against a double submit the same way rather than each one
 * remembering to.
 */
function SubmitButton({
  isEdit = false,
  createLabel = 'Create',
  editLabel = 'Save changes',
  savingLabel = 'Saving…',
  icon,
  ...props
}: SubmitButtonProps) {
  const form = useFormContext();
  const canSubmit = useStore(form.store, (s) => s.canSubmit);
  const isSubmitting = useStore(form.store, (s) => s.isSubmitting);

  // A `Pressable` is not a form control, so it never raises the DOM submit event
  // `<Form>` listens for — it has to call `handleSubmit` itself. Enter inside a
  // field still goes through `<form onSubmit>`, and because pressing this button
  // is not a submit, the two cannot both fire for one press.
  return (
    <Button
      disabled={!canSubmit || isSubmitting}
      onPress={() => {
        form.handleSubmit();
      }}
      {...props}
    >
      {icon}
      {isSubmitting ? savingLabel : isEdit ? editLabel : createLabel}
    </Button>
  );
}

export {
  Field,
  FieldControl,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldRow,
  FieldWrapper,
  Form,
  InputField,
  SelectField,
  SubmitButton,
  TextAreaField,
};
