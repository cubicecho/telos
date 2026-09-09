import { useMutation } from '@apollo/client';
import { type FormEvent, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CreateLabelDocument, LabelsDocument, UpdateLabelDocument } from '@/lib/graphql';
import type { LabelSummary } from './label-badge';

/** A small fixed palette — picking a colour should be one click, not a colour wheel. */
const PALETTE = ['#0f766e', '#0369a1', '#4f46e5', '#7c3aed', '#be185d', '#b91c1c', '#c2410c', '#4d7c0f'];

export function LabelFormDialog({
  open,
  onOpenChange,
  label,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label?: LabelSummary;
}) {
  const [name, setName] = useState('');
  const [color, setColor] = useState(PALETTE[0]);
  const [createLabel, { loading: creating, error: createError }] = useMutation(CreateLabelDocument, {
    refetchQueries: [LabelsDocument],
  });
  const [updateLabel, { loading: updating, error: updateError }] = useMutation(UpdateLabelDocument, {
    refetchQueries: [LabelsDocument],
  });

  useEffect(() => {
    if (!open) return;
    setName(label?.name ?? '');
    setColor(label?.color ?? PALETTE[0]);
  }, [open, label]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const values = { name: name.trim(), color };
    if (values.name === '') return;
    if (label) await updateLabel({ variables: { id: label.id, set: values } });
    else await createLabel({ variables: { values } });
    onOpenChange(false);
  }

  const error = createError ?? updateError;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{label ? 'Rename label' : 'New label'}</DialogTitle>
          <DialogDescription>Labels can be attached to both projects and todos.</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="label-name">Name</Label>
            <Input
              id="label-name"
              value={name}
              autoFocus
              placeholder="urgent"
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label>Colour</Label>
            <div className="flex flex-wrap gap-2">
              {PALETTE.map((swatch) => (
                <button
                  key={swatch}
                  type="button"
                  aria-label={swatch}
                  aria-pressed={swatch === color}
                  onClick={() => setColor(swatch)}
                  className={
                    swatch === color
                      ? 'h-7 w-7 rounded-full ring-2 ring-ring ring-offset-2 ring-offset-background'
                      : 'h-7 w-7 rounded-full'
                  }
                  style={{ backgroundColor: swatch }}
                />
              ))}
            </div>
          </div>
          {error ? <p className="text-destructive text-sm">{error.message}</p> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={creating || updating || name.trim() === ''}>
              {label ? 'Save' : 'Create'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
