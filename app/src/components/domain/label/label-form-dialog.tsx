import { useApolloClient, useMutation } from '@apollo/client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ColorPicker, isHexColor } from '@/components/ui/color-picker';
import { Field, FieldLabel, FieldTitle } from '@/components/ui/field';
import { FormDialog, FormDialogFooter } from '@/components/ui/form-dialog';
import { FormElement } from '@/components/ui/form-element';
import { Input } from '@/components/ui/input';
import { describeError } from '@/lib/errors';
import { CreateLabelDocument, LabelsDocument, UpdateLabelDocument } from '@/lib/graphql';
import { newId } from '@/lib/ids';
import type { LabelSummary } from './label-badge';

/** A small fixed palette — picking a colour should be one click, not a colour wheel. */
const PALETTE = ['#0f766e', '#0369a1', '#4f46e5', '#7c3aed', '#be185d', '#b91c1c', '#c2410c', '#4d7c0f'];
const FIRST = PALETTE[0] as string;

export function LabelFormDialog({
  open,
  onOpenChange,
  label,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label?: LabelSummary | undefined;
}) {
  const client = useApolloClient();
  const [name, setName] = useState('');
  const [color, setColor] = useState(FIRST);
  const [createLabel, { loading: creating, error: createError }] = useMutation(CreateLabelDocument);
  const [updateLabel, { loading: updating, error: updateError }] = useMutation(UpdateLabelDocument);

  /** Put the list back in name order, which is the only thing a rename can disturb. */
  function sortLabels() {
    client.cache.updateQuery({ query: LabelsDocument }, (existing) =>
      existing ? { ...existing, labels: [...existing.labels].sort((a, b) => a.name.localeCompare(b.name)) } : existing,
    );
  }

  useEffect(() => {
    if (!open) return;
    setName(label?.name ?? '');
    setColor(label?.color ?? FIRST);
  }, [open, label]);

  // cubeui's picker also takes a typed hex, so the colour can be half-typed.
  const canSubmit = name.trim() !== '' && isHexColor(color) && !creating && !updating;

  async function onSubmit() {
    const values = { name: name.trim(), color };
    if (!canSubmit) return;
    try {
      if (label) {
        // A rename needs no cache work of its own: `Label` is normalized, so the
        // mutation's own result updates every badge showing it. Only the list's
        // order is the query's to decide, hence the re-sort below.
        await updateLabel({ variables: { id: label.id, set: values } });
        sortLabels();
      } else {
        const id = newId();
        await createLabel({
          variables: { values: { id, ...values } },
          optimisticResponse: { createLabel: { __typename: 'Label', id, name: values.name, color: values.color } },
          update(cache, { data }) {
            const created = data?.createLabel;
            if (!created) return;
            cache.updateQuery({ query: LabelsDocument }, (existing) =>
              existing
                ? {
                    ...existing,
                    labels: [...existing.labels.filter((row) => row.id !== created.id), created].sort((a, b) =>
                      a.name.localeCompare(b.name),
                    ),
                  }
                : existing,
            );
          },
        });
      }
    } catch {
      // The mutation rejects as well as setting `error`, so an uncaught await
      // here is both an unhandled rejection and a dialog that stays open with
      // no explanation of why. Stay open — deliberately — but say so: what was
      // typed is still in the fields, ready to send again.
      return;
    }
    onOpenChange(false);
  }

  const error = createError ?? updateError;

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={label ? 'Rename label' : 'New label'}
      description="Labels can be attached to both projects and todos."
    >
      <FormElement onSubmit={onSubmit} className="gap-4">
        <Field>
          <FieldLabel htmlFor="label-name">Name</FieldLabel>
          <Input id="label-name" value={name} autoFocus placeholder="urgent" onChangeText={setName} />
        </Field>
        <Field>
          <FieldTitle>Colour</FieldTitle>
          <ColorPicker value={color} onChange={setColor} colors={PALETTE} />
        </Field>
        <FormDialogFooter onCancel={() => onOpenChange(false)} error={error ? describeError(error) : null}>
          {/* A Pressable raises no DOM submit, so it calls the handler itself;
              Enter in the name field still submits through `FormElement`. */}
          <Button disabled={!canSubmit} onPress={onSubmit}>
            {label ? 'Save' : 'Create'}
          </Button>
        </FormDialogFooter>
      </FormElement>
    </FormDialog>
  );
}
