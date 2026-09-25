import { useApolloClient, useMutation } from '@apollo/client';
import { useEffect } from 'react';
import { useAppForm } from '@/components/app-form';
import { isHexColor } from '@/components/ui/color-picker';
import { Form } from '@/components/ui/form';
import { FormDialog, FormDialogFooter } from '@/components/ui/form-dialog';
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
  const [createLabel, { loading: creating, error: createError }] = useMutation(CreateLabelDocument);
  const [updateLabel, { loading: updating, error: updateError }] = useMutation(UpdateLabelDocument);

  /** Put the list back in name order, which is the only thing a rename can disturb. */
  function sortLabels() {
    client.cache.updateQuery({ query: LabelsDocument }, (existing) =>
      existing ? { ...existing, labels: [...existing.labels].sort((a, b) => a.name.localeCompare(b.name)) } : existing,
    );
  }

  const form = useAppForm({
    defaultValues: { name: '', color: FIRST },
    onSubmit: ({ value }) => save(value),
  });

  useEffect(() => {
    if (!open) return;
    form.reset({ name: label?.name ?? '', color: label?.color ?? FIRST });
  }, [open, label, form]);

  async function save({ name, color }: { name: string; color: string }) {
    const values = { name: name.trim(), color };
    if (creating || updating) return;
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
      <form.AppForm>
        <Form className="gap-4">
          <form.AppField
            name="name"
            validators={{ onChange: ({ value }) => (value.trim() === '' ? 'Give the label a name.' : undefined) }}
          >
            {(field) => <field.InputField label="Name" autoFocus placeholder="urgent" />}
          </form.AppField>
          {/* cubeui's picker also takes a typed hex, so the colour can be half-typed. */}
          <form.AppField
            name="color"
            validators={{
              onChange: ({ value }) => (isHexColor(value) ? undefined : 'Pick a colour, or finish the hex.'),
            }}
          >
            {(field) => <field.ColorField label="Colour" colors={PALETTE} />}
          </form.AppField>
          <FormDialogFooter onCancel={() => onOpenChange(false)} error={error ? describeError(error) : null}>
            <form.SubmitButton isEdit={label !== undefined} editLabel="Save" />
          </FormDialogFooter>
        </Form>
      </form.AppForm>
    </FormDialog>
  );
}
