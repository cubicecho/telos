import { useMutation } from '@apollo/client';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import type { LanePresetFieldsFragment, StationFieldsFragment } from '@/__generated__/graphql';
import { useAppForm } from '@/components/app-form';
import type { LaneSummary } from '@/components/domain/lane/lane-badge';
import { Button } from '@/components/ui/button';
import { Form } from '@/components/ui/form';
import { FormDialog, FormDialogFooter } from '@/components/ui/form-dialog';
import { Input } from '@/components/ui/input';
import { numberRule } from '@/lib/agents';
import { describeError } from '@/lib/errors';
import { ProjectStationsDocument, SaveLaneAsPresetDocument, UpdateStationDocument } from '@/lib/graphql';
import { newId } from '@/lib/ids';
import {
  CONTRACTS,
  describePresetValue,
  joinPrompts,
  overridesOf,
  PRESET_FIELD_LABELS,
  PRESET_FIELDS,
  type PresetField,
  presetValue,
} from '@/lib/lane-presets';

/** "No agent", "no preset" and "stay here", as a select can hold them: radix refuses an empty value. */
const NONE = 'none';

/** "Archive it" among the lanes a pass can send a todo to: one answer, never both. */
const ARCHIVE = 'archive';

/** What each of a preset's fields is called as a form label. */
const FIELD_TITLES: Record<PresetField, string> = {
  contract: 'Contract',
  wipLimit: 'Work at once (WIP limit)',
  maxAttempts: 'Attempts before leaving it for you',
};

export interface StationAgent {
  id: string;
  name: string;
}

export type StationPreset = LanePresetFieldsFragment;

export interface StationDraft {
  agentId: string;
  /** The preset the lane follows, or `NONE`. */
  presetId: string;
  /** Which of the preset's fields the lane keeps its own value for. */
  presetOverrides: PresetField[];
  contract: string;
  /** The lane's own prompt: all of it without a preset, and what it adds after the preset's with one. */
  prompt: string;
  /** A lane's id, `ARCHIVE` or `NONE`. */
  onSuccess: string;
  onFailureLaneId: string;
  wipLimit: string;
  maxAttempts: string;
}

/**
 * Reads a station into what the form holds.
 *
 * @param station - The lane's station settings, or null before they load.
 * @returns The form's values.
 */
export function toDraft(station: StationFieldsFragment | null): StationDraft {
  return {
    agentId: station?.agentId ?? NONE,
    presetId: station?.presetId ?? NONE,
    presetOverrides: overridesOf(station?.presetOverrides),
    contract: station?.contract ?? 'work',
    prompt: station?.prompt ?? '',
    onSuccess: station?.archiveOnSuccess ? ARCHIVE : (station?.onSuccessLaneId ?? NONE),
    onFailureLaneId: station?.onFailureLaneId ?? NONE,
    wipLimit: String(station?.wipLimit ?? 1),
    maxAttempts: String(station?.maxAttempts ?? 3),
  };
}

const orNone = (value: string) => (value === NONE ? null : value);

/**
 * Turns the form's values into the lane columns to write. Archiving and the
 * success arrow are written together, so choosing one always clears the other.
 *
 * A field the lane takes from its preset is left out: the server fills it in
 * from the preset as it is now, which may be newer than what the form was
 * shown, and a value written here would count as the lane's own.
 *
 * @param value - The form's values.
 * @returns The columns for `updateLane`.
 */
export function toStationSet(value: StationDraft) {
  const archives = value.onSuccess === ARCHIVE;
  const follows = value.presetId !== NONE;
  const own = (field: PresetField) => !follows || value.presetOverrides.includes(field);
  return {
    agentId: orNone(value.agentId),
    presetId: orNone(value.presetId),
    presetOverrides: follows ? value.presetOverrides : [],
    ...(own('contract') ? { contract: value.contract } : {}),
    prompt: value.prompt.trim() === '' ? null : value.prompt.trim(),
    onSuccessLaneId: archives ? null : orNone(value.onSuccess),
    archiveOnSuccess: archives,
    onFailureLaneId: orNone(value.onFailureLaneId),
    ...(own('wipLimit') ? { wipLimit: Number(value.wipLimit) } : {}),
    ...(own('maxAttempts') ? { maxAttempts: Number(value.maxAttempts) } : {}),
  };
}

/**
 * Says what is wrong with a station's answer to success, if anything.
 *
 * @param contract - The station's contract.
 * @param onSuccess - A lane's id, `ARCHIVE` or `NONE`.
 * @returns The message to show, or undefined when the answer stands.
 */
export function successRule(contract: string, onSuccess: string): string | undefined {
  if (contract !== 'expand') {
    return undefined;
  }
  if (onSuccess === ARCHIVE) {
    return 'An expand station cannot archive: the todo waits on what it adds. Pick a lane for them.';
  }
  if (onSuccess === NONE) {
    return 'An expand station needs somewhere to send what it adds.';
  }
  return undefined;
}

/**
 * One of a preset's fields on a lane that follows it: the preset's value with a
 * way to override it, or the lane's own with a way to put the preset's back.
 */
function PresetFieldRow({
  field,
  preset,
  overridden,
  onOverride,
  onPutBack,
  children,
}: {
  field: PresetField;
  preset: StationPreset;
  overridden: boolean;
  onOverride: () => void;
  onPutBack: () => void;
  /** The field itself, drawn when the lane has its own value. */
  children: ReactNode;
}) {
  const name = PRESET_FIELD_LABELS[field];
  const fromPreset = describePresetValue(preset, field);
  if (!overridden) {
    return (
      <View className="gap-1">
        <Text className="font-medium text-foreground text-sm">{FIELD_TITLES[field]}</Text>
        <View className="flex-row items-center gap-2">
          <Text className="min-w-0 flex-1 text-foreground text-sm">{fromPreset}</Text>
          <Button variant="outline" size="sm" aria-label={`Override the preset’s ${name}`} onPress={onOverride}>
            Override
          </Button>
        </View>
        <Text className="text-muted-foreground text-xs">From the preset “{preset.name}”.</Text>
      </View>
    );
  }
  return (
    <View className="gap-1">
      {children}
      <View className="flex-row items-center gap-2">
        <Text className="min-w-0 flex-1 text-muted-foreground text-xs">
          Overridden here. “{preset.name}” says: {fromPreset}
        </Text>
        <Button variant="ghost" size="sm" aria-label={`Put the ${name} back to the preset’s`} onPress={onPutBack}>
          Put back
        </Button>
      </View>
    </View>
  );
}

/**
 * What a lane does as a station: which agent works the todos that arrive in
 * it, under which contract, and where each goes when the agent is done.
 *
 * No agent means an ordinary lane. The other settings are kept when the agent
 * is taken away, so putting one back restores the station as it was.
 *
 * A station may follow a preset: it then has the preset's contract, WIP limit
 * and attempts, bar the ones it overrides here, and its prompt is added after
 * the preset's.
 */
export function StationDialog({
  open,
  onOpenChange,
  lane,
  lanes,
  station,
  agents,
  presets = [],
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lane: LaneSummary;
  lanes: readonly LaneSummary[];
  station: StationFieldsFragment | null;
  agents: readonly StationAgent[];
  presets?: readonly StationPreset[] | undefined;
}) {
  const [updateStation, { error: updateError }] = useMutation(UpdateStationDocument);
  // The lane follows the preset it is saved as, which is the lane's station changing.
  const [saveAsPreset, { error: presetError }] = useMutation(SaveLaneAsPresetDocument, {
    refetchQueries: [ProjectStationsDocument],
  });
  const error = updateError ?? presetError;
  const initial = useMemo(() => toDraft(station), [station]);
  const form = useAppForm({
    defaultValues: initial,
    onSubmit: ({ value }) => save(value),
  });
  // The preset's name while "Save as a preset" is open, and null while it is not.
  const [presetName, setPresetName] = useState<string | null>(null);
  // Set for the one submit that is to make a preset of what it saves.
  const savingAs = useRef<string | null>(null);
  // The preset the form last followed, to know which one is being let go.
  const followed = useRef(initial.presetId);

  useEffect(() => {
    if (open) {
      form.reset(initial);
      followed.current = initial.presetId;
      setPresetName(null);
    }
  }, [open, initial, form]);

  async function save(value: StationDraft) {
    const asPreset = savingAs.current;
    try {
      await updateStation({
        variables: {
          id: lane.id,
          set: toStationSet(value),
        },
      });
      if (asPreset !== null) {
        await saveAsPreset({ variables: { laneId: lane.id, name: asPreset, id: newId() } });
      }
    } catch {
      return;
    }
    onOpenChange(false);
  }

  async function submitAsPreset(name: string) {
    savingAs.current = name;
    try {
      await form.handleSubmit();
    } finally {
      savingAs.current = null;
    }
  }

  /** Takes a preset's values when one is chosen, and keeps what it said when it is let go. */
  function follow(next: string) {
    const left = presets.find((row) => row.id === followed.current);
    const preset = presets.find((row) => row.id === next);
    followed.current = next;
    form.setFieldValue('presetOverrides', []);
    if (preset) {
      for (const field of PRESET_FIELDS) {
        form.setFieldValue(field, presetValue(preset, field));
      }
      return;
    }
    // The preset's prompt was half of what the agent was told here, so it stays.
    if (left) {
      form.setFieldValue('prompt', joinPrompts(left.prompt, form.getFieldValue('prompt')));
    }
  }

  function override(field: PresetField) {
    form.setFieldValue('presetOverrides', overridesOf([...form.getFieldValue('presetOverrides'), field]));
  }

  function putBack(field: PresetField, preset: StationPreset) {
    form.setFieldValue(
      'presetOverrides',
      form.getFieldValue('presetOverrides').filter((name) => name !== field),
    );
    form.setFieldValue(field, presetValue(preset, field));
  }

  const agentOptions = [
    { value: NONE, label: 'None — an ordinary lane' },
    ...agents.map((a) => ({ value: a.id, label: a.name })),
  ];
  const presetOptions = [
    { value: NONE, label: 'None — set it all here' },
    ...presets.map((row) => ({ value: row.id, label: row.name })),
  ];
  const otherLanes = lanes.filter((row) => row.id !== lane.id).map((row) => ({ value: row.id, label: row.name }));
  const failureOptions = [{ value: NONE, label: 'Stay here' }, ...otherLanes];
  const successOptions = [
    { value: NONE, label: 'Stay here' },
    { value: ARCHIVE, label: 'Archive it — done, and off the board' },
    ...otherLanes.map((row) => ({ ...row, label: `Move to ${row.label}` })),
  ];

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`${lane.name} as a station`}
      description="An agent works each todo that arrives here, then sends it on."
      className="sm:max-w-[520px]"
    >
      <form.AppForm>
        <Form className="gap-4">
          <form.AppField name="agentId">
            {(field) => <field.SelectField label="Agent" options={agentOptions} />}
          </form.AppField>
          {agents.length === 0 ? (
            <Text className="text-muted-foreground text-xs">Add an agent in Settings → AI first.</Text>
          ) : null}
          <form.Subscribe
            selector={(state) => ({
              agentId: state.values.agentId,
              presetId: state.values.presetId,
              presetOverrides: state.values.presetOverrides,
            })}
          >
            {({ agentId, presetId, presetOverrides }) => {
              if (agentId === NONE) {
                return null;
              }
              const preset = presets.find((row) => row.id === presetId) ?? null;
              // A preset's field: the lane's own without a preset, and through `PresetFieldRow` with one.
              const followable = (field: PresetField, control: ReactNode) =>
                preset ? (
                  <PresetFieldRow
                    field={field}
                    preset={preset}
                    overridden={presetOverrides.includes(field)}
                    onOverride={() => override(field)}
                    onPutBack={() => putBack(field, preset)}
                  >
                    {control}
                  </PresetFieldRow>
                ) : (
                  control
                );
              return (
                <>
                  {presets.length === 0 ? null : (
                    <form.AppField name="presetId" listeners={{ onChange: ({ value }) => follow(value) }}>
                      {(field) => <field.SelectField label="Start from a preset" options={presetOptions} />}
                    </form.AppField>
                  )}
                  {followable(
                    'contract',
                    <form.AppField name="contract">
                      {(field) => <field.SelectField label={FIELD_TITLES.contract} options={CONTRACTS} />}
                    </form.AppField>,
                  )}
                  {preset ? (
                    <View className="gap-1">
                      <Text className="font-medium text-foreground text-sm">Prompt from “{preset.name}”</Text>
                      <Text className="rounded-md border border-border bg-muted px-3 py-2 text-muted-foreground text-sm">
                        {preset.prompt?.trim() || 'It has none.'}
                      </Text>
                    </View>
                  ) : null}
                  <form.AppField name="prompt">
                    {(field) => (
                      <field.TextAreaField
                        label={preset ? 'Prompt added here, after the preset’s' : 'Prompt'}
                        placeholder={
                          preset
                            ? 'Optional. What this lane adds to the preset’s prompt.'
                            : "The job here, on top of the agent's own prompt."
                        }
                      />
                    )}
                  </form.AppField>
                  <form.AppField
                    name="onSuccess"
                    validators={{
                      onChangeListenTo: ['contract'],
                      onChange: ({ value, fieldApi }) => successRule(fieldApi.form.getFieldValue('contract'), value),
                    }}
                  >
                    {(field) => <field.SelectField label="On success" options={successOptions} />}
                  </form.AppField>
                  <form.AppField name="onFailureLaneId">
                    {(field) => <field.SelectField label="On failure, move to" options={failureOptions} />}
                  </form.AppField>
                  {followable(
                    'wipLimit',
                    <form.AppField name="wipLimit" validators={{ onChange: numberRule({ min: 1, required: true }) }}>
                      {(field) => <field.InputField label={FIELD_TITLES.wipLimit} inputMode="numeric" />}
                    </form.AppField>,
                  )}
                  {followable(
                    'maxAttempts',
                    <form.AppField name="maxAttempts" validators={{ onChange: numberRule({ min: 0, required: true }) }}>
                      {(field) => <field.InputField label={FIELD_TITLES.maxAttempts} inputMode="numeric" />}
                    </form.AppField>,
                  )}
                  {presetName === null ? (
                    <Button variant="outline" size="sm" className="self-start" onPress={() => setPresetName('')}>
                      Save as a preset…
                    </Button>
                  ) : (
                    <View className="gap-1">
                      <View className="flex-row items-center gap-2">
                        <Input
                          className="flex-1"
                          value={presetName}
                          aria-label="Preset name"
                          placeholder="Name the preset"
                          onChangeText={setPresetName}
                        />
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={presetName.trim() === ''}
                          onPress={() => void submitAsPreset(presetName.trim())}
                        >
                          Save preset
                        </Button>
                      </View>
                      <Text className="text-muted-foreground text-xs">
                        Saves this station, makes a preset of it, and has the lane follow that preset.
                      </Text>
                    </View>
                  )}
                </>
              );
            }}
          </form.Subscribe>
          <FormDialogFooter onCancel={() => onOpenChange(false)} error={error ? describeError(error) : null}>
            <form.SubmitButton isEdit editLabel="Save" />
          </FormDialogFooter>
        </Form>
      </form.AppForm>
    </FormDialog>
  );
}
