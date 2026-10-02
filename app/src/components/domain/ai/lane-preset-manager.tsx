import { useMutation, useQuery } from '@apollo/client';
import { useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import type { LanePresetsQuery } from '@/__generated__/graphql';
import { useAppForm } from '@/components/app-form';
import { Section } from '@/components/section';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Form } from '@/components/ui/form';
import { FormDialog, FormDialogFooter } from '@/components/ui/form-dialog';
import { Pencil, Plus, Trash2 } from '@/components/ui/icons';
import { LoadState } from '@/components/ui/load-failure';
import { numberRule } from '@/lib/agents';
import { describeError } from '@/lib/errors';
import {
  CreateLanePresetDocument,
  DeleteLanePresetDocument,
  LanePresetsDocument,
  UpdateLanePresetDocument,
} from '@/lib/graphql';
import { newId } from '@/lib/ids';
import { CONTRACTS, describeOverrides, describePresetValue } from '@/lib/lane-presets';

type PresetRow = LanePresetsQuery['lanePresets'][number];

/** What a new preset starts as: the same as a lane that has never been a station. */
const NEW_PRESET = { contract: 'work', wipLimit: 1, maxAttempts: 3 } as const;

export interface PresetDraft {
  name: string;
  contract: string;
  prompt: string;
  wipLimit: string;
  maxAttempts: string;
}

/**
 * Reads a preset into what its form holds.
 *
 * @param preset - The preset, or null for a new one.
 * @returns The form's values.
 */
export function toPresetDraft(preset: PresetRow | null): PresetDraft {
  return {
    name: preset?.name ?? '',
    contract: preset?.contract ?? NEW_PRESET.contract,
    prompt: preset?.prompt ?? '',
    wipLimit: String(preset?.wipLimit ?? NEW_PRESET.wipLimit),
    maxAttempts: String(preset?.maxAttempts ?? NEW_PRESET.maxAttempts),
  };
}

/**
 * Turns the form's values into the preset's columns.
 *
 * @param value - The form's values.
 * @returns The columns for `createLanePreset` and `updateLanePreset`.
 */
export function fromPresetDraft(value: PresetDraft) {
  return {
    name: value.name.trim(),
    contract: value.contract,
    prompt: value.prompt.trim() === '' ? null : value.prompt.trim(),
    wipLimit: Number(value.wipLimit),
    maxAttempts: Number(value.maxAttempts),
  };
}

/**
 * Lane presets: a station's contract, prompt and limits, kept once so many
 * lanes can follow them. Rendered only while AI is on for the instance and the
 * account — the schema has no presets otherwise.
 *
 * Each preset lists the lanes that follow it and what each has overridden, so
 * an edit here is made knowing where it lands.
 */
export function LanePresetManager() {
  const presetsQuery = useQuery(LanePresetsDocument);
  const [editing, setEditing] = useState<PresetRow | 'new' | null>(null);
  const [deleting, setDeleting] = useState<PresetRow | null>(null);
  const [deletePreset] = useMutation(DeleteLanePresetDocument, { refetchQueries: [LanePresetsDocument] });
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const presets = presetsQuery.data?.lanePresets ?? [];

  async function confirmDelete() {
    setDeleteError(null);
    try {
      if (deleting) {
        await deletePreset({ variables: { id: deleting.id } });
      }
    } catch (cause) {
      setDeleteError(describeError(cause));
    }
    setDeleting(null);
  }

  return (
    <Section
      surface="card"
      title="Lane presets"
      description="A station’s contract, prompt and limits, kept once. A lane that follows a preset changes when the preset does, bar what it overrides."
      action={
        <Button size="sm" onPress={() => setEditing('new')}>
          <Plus className="h-4 w-4" />
          New preset
        </Button>
      }
      content={
        <View className="gap-4">
          {deleteError ? (
            <Text className="text-destructive text-sm" aria-live="polite">
              {deleteError}
            </Text>
          ) : null}

          <LoadState
            query={presetsQuery}
            what="your lane presets"
            count={presets.length}
            empty={<Text className="text-muted-foreground text-sm">No presets yet.</Text>}
          />
          {presets.length === 0 ? null : (
            <View role="list" className="gap-1">
              {presets.map((preset) => (
                <View
                  key={preset.id}
                  role="listitem"
                  className="gap-2 rounded-lg border border-border bg-card px-3 py-2"
                >
                  <View className="flex-row items-center gap-3">
                    <View className="flex-1 gap-0.5">
                      <Text numberOfLines={1} className="text-foreground text-sm">
                        {preset.name}
                      </Text>
                      <Text numberOfLines={1} className="text-muted-foreground text-xs">
                        {describePresetValue(preset, 'contract')} · WIP {preset.wipLimit} · {preset.maxAttempts}{' '}
                        attempts
                      </Text>
                    </View>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Edit ${preset.name}`}
                      onPress={() => setEditing(preset)}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="hover:text-destructive"
                      aria-label={`Delete ${preset.name}`}
                      onPress={() => setDeleting(preset)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </View>
                  <PresetLanes preset={preset} />
                </View>
              ))}
            </View>
          )}

          {/* Keyed so switching from one preset to another starts a fresh form. */}
          {editing ? (
            <LanePresetFormDialog
              key={editing === 'new' ? 'new' : editing.id}
              open
              onOpenChange={(open) => !open && setEditing(null)}
              preset={editing === 'new' ? null : editing}
            />
          ) : null}

          <ConfirmDialog
            open={deleting !== null}
            onOpenChange={(open) => !open && setDeleting(null)}
            title={`Delete “${deleting?.name ?? 'this preset'}”?`}
            description={deleteWarning(deleting?.lanes.length ?? 0)}
            confirmLabel="Delete"
            onConfirm={confirmDelete}
          />
        </View>
      }
    />
  );
}

/**
 * What deleting a preset does to the lanes following it, for the confirmation.
 *
 * @param lanes - How many lanes follow the preset.
 * @returns The sentence to show.
 */
export function deleteWarning(lanes: number): string {
  if (lanes === 0) {
    return 'No lane follows it. This cannot be undone.';
  }
  const who = lanes === 1 ? 'The 1 lane following it keeps' : `The ${lanes} lanes following it keep`;
  return `${who} working as now: its values and prompt are copied into each first. This cannot be undone.`;
}

/** The lanes that follow a preset, each with what it has overridden. */
function PresetLanes({ preset }: { preset: PresetRow }) {
  if (preset.lanes.length === 0) {
    return <Text className="text-muted-foreground text-xs">No lane follows it yet.</Text>;
  }
  return (
    <View role="list" aria-label={`Lanes following ${preset.name}`} className="gap-0.5">
      {preset.lanes.map((lane) => (
        <Text key={lane.id} role="listitem" className="text-muted-foreground text-xs">
          <Text className="text-foreground">{lane.project ? `${lane.project.name} › ${lane.name}` : lane.name}</Text>
          {' — '}
          {describeOverrides(lane.presetOverrides)}
        </Text>
      ))}
    </View>
  );
}

/** Creating a preset or editing one. An edit reaches every lane following it. */
export function LanePresetFormDialog({
  open,
  onOpenChange,
  preset,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preset: PresetRow | null;
}) {
  const isEdit = preset !== null;
  // Refetched after an edit too: the lanes beneath a preset are listed with it.
  const [createPreset, createState] = useMutation(CreateLanePresetDocument, { refetchQueries: [LanePresetsDocument] });
  const [updatePreset, updateState] = useMutation(UpdateLanePresetDocument, { refetchQueries: [LanePresetsDocument] });
  const error = createState.error ?? updateState.error;
  const initial = useMemo(() => toPresetDraft(preset), [preset]);
  const form = useAppForm({
    defaultValues: initial,
    onSubmit: ({ value }) => save(value),
  });

  useEffect(() => {
    if (open) {
      form.reset(initial);
    }
  }, [open, initial, form]);

  async function save(value: PresetDraft) {
    const values = fromPresetDraft(value);
    try {
      if (preset) {
        await updatePreset({ variables: { id: preset.id, set: values } });
      } else {
        await createPreset({ variables: { values: { id: newId(), ...values } } });
      }
    } catch {
      // `error` says why, beside the buttons; what was typed stays.
      return;
    }
    onOpenChange(false);
  }

  const following = preset?.lanes.length ?? 0;

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? `Edit ${preset.name}` : 'New lane preset'}
      description={
        following > 0
          ? `Changes reach the ${following === 1 ? 'lane' : `${following} lanes`} following it, bar what each overrides.`
          : 'What a station does, to start lanes from and keep them in step.'
      }
      className="sm:max-w-[520px]"
    >
      <form.AppForm>
        <Form className="gap-4">
          <form.AppField
            name="name"
            validators={{ onChange: ({ value }) => (value.trim() === '' ? 'A preset needs a name.' : undefined) }}
          >
            {(field) => <field.InputField label="Name" autoFocus placeholder="Code review" />}
          </form.AppField>
          <form.AppField name="contract">
            {(field) => <field.SelectField label="Contract" options={CONTRACTS} />}
          </form.AppField>
          <form.AppField name="prompt">
            {(field) => (
              <field.TextAreaField
                label="Prompt"
                placeholder="The job at a station like this. A lane’s own prompt is added after it."
              />
            )}
          </form.AppField>
          <form.AppField name="wipLimit" validators={{ onChange: numberRule({ min: 1, required: true }) }}>
            {(field) => <field.InputField label="Work at once (WIP limit)" inputMode="numeric" />}
          </form.AppField>
          <form.AppField name="maxAttempts" validators={{ onChange: numberRule({ min: 0, required: true }) }}>
            {(field) => <field.InputField label="Attempts before leaving it for you" inputMode="numeric" />}
          </form.AppField>
          <FormDialogFooter onCancel={() => onOpenChange(false)} error={error ? describeError(error) : null}>
            <form.SubmitButton isEdit={isEdit} createLabel="Create preset" editLabel="Save" />
          </FormDialogFooter>
        </Form>
      </form.AppForm>
    </FormDialog>
  );
}
