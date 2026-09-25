import { useMutation } from '@apollo/client';
import { useEffect } from 'react';
import { useAppForm } from '@/components/app-form';
import { Form } from '@/components/ui/form';
import { FormDialog, FormDialogFooter } from '@/components/ui/form-dialog';
import { describeError } from '@/lib/errors';
import { BoardTemplatesDocument, SaveBoardTemplateDocument } from '@/lib/graphql';

/**
 * Saves a project's lanes, and what its stations do, as a template to start
 * another project from. A template of the same name is replaced, which is how
 * one is updated.
 */
export function SaveTemplateDialog({
  open,
  onOpenChange,
  projectId,
  projectName,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  projectName: string;
  /** Told the name it was saved under, since the dialog closes on it. */
  onSaved?: (name: string) => void;
}) {
  const [save, { loading, error }] = useMutation(SaveBoardTemplateDocument, {
    refetchQueries: [BoardTemplatesDocument],
  });
  const form = useAppForm({
    defaultValues: { name: '' },
    onSubmit: async ({ value }) => {
      if (loading) return;
      try {
        await save({ variables: { projectId, name: value.name.trim() } });
      } catch {
        return;
      }
      onOpenChange(false);
      onSaved?.(value.name.trim());
    },
  });

  useEffect(() => {
    if (!open) return;
    form.reset({ name: projectName });
  }, [open, projectName, form]);

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Save as template"
      description="Its lanes and what their stations do, not its todos. A template of the same name is replaced."
    >
      <form.AppForm>
        <Form className="gap-4">
          <form.AppField
            name="name"
            validators={{ onChange: ({ value }) => (value.trim() === '' ? 'Name the template.' : undefined) }}
          >
            {(field) => <field.InputField label="Template name" autoFocus maxLength={100} />}
          </form.AppField>
          <FormDialogFooter onCancel={() => onOpenChange(false)} error={error ? describeError(error) : null}>
            <form.SubmitButton createLabel="Save template" />
          </FormDialogFooter>
        </Form>
      </form.AppForm>
    </FormDialog>
  );
}
