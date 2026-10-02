import { useMutation } from '@apollo/client';
import { useEffect, useMemo } from 'react';
import { Text } from 'react-native';
import type { StationFieldsFragment } from '@/__generated__/graphql';
import { useAppForm } from '@/components/app-form';
import type { LaneSummary } from '@/components/domain/lane/lane-badge';
import { Form } from '@/components/ui/form';
import { FormDialog, FormDialogFooter } from '@/components/ui/form-dialog';
import { numberRule } from '@/lib/agents';
import { describeError } from '@/lib/errors';
import { UpdateStationDocument } from '@/lib/graphql';

/** "No agent" and "stay here", as a select can hold them: radix refuses an empty value. */
const NONE = 'none';

/** "Archive it" among the lanes a pass can send a todo to: one answer, never both. */
const ARCHIVE = 'archive';

const CONTRACTS = [
  { value: 'work', label: 'Work — do the job, then move it on' },
  { value: 'verdict', label: 'Verdict — judge it: pass or fail' },
  { value: 'expand', label: 'Expand — break it into new todos' },
] as const;

export interface StationAgent {
  id: string;
  name: string;
}

export interface StationDraft {
  agentId: string;
  contract: string;
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
 * @param value - The form's values.
 * @returns The columns for `updateLane`.
 */
export function toStationSet(value: StationDraft) {
  const archives = value.onSuccess === ARCHIVE;
  return {
    agentId: orNone(value.agentId),
    contract: value.contract,
    prompt: value.prompt.trim() === '' ? null : value.prompt.trim(),
    onSuccessLaneId: archives ? null : orNone(value.onSuccess),
    archiveOnSuccess: archives,
    onFailureLaneId: orNone(value.onFailureLaneId),
    wipLimit: Number(value.wipLimit),
    maxAttempts: Number(value.maxAttempts),
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
 * What a lane does as a station: which agent works the todos that arrive in
 * it, under which contract, and where each goes when the agent is done.
 *
 * No agent means an ordinary lane. The other settings are kept when the agent
 * is taken away, so putting one back restores the station as it was.
 */
export function StationDialog({
  open,
  onOpenChange,
  lane,
  lanes,
  station,
  agents,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lane: LaneSummary;
  lanes: readonly LaneSummary[];
  station: StationFieldsFragment | null;
  agents: readonly StationAgent[];
}) {
  const [updateStation, { error }] = useMutation(UpdateStationDocument);
  const initial = useMemo(() => toDraft(station), [station]);
  const form = useAppForm({
    defaultValues: initial,
    onSubmit: ({ value }) => save(value),
  });

  useEffect(() => {
    if (open) form.reset(initial);
  }, [open, initial, form]);

  async function save(value: StationDraft) {
    try {
      await updateStation({
        variables: {
          id: lane.id,
          set: toStationSet(value),
        },
      });
    } catch {
      return;
    }
    onOpenChange(false);
  }

  const agentOptions = [
    { value: NONE, label: 'None — an ordinary lane' },
    ...agents.map((a) => ({ value: a.id, label: a.name })),
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
          <form.Subscribe selector={(state) => state.values.agentId}>
            {(agentId) =>
              agentId === NONE ? null : (
                <>
                  <form.AppField name="contract">
                    {(field) => <field.SelectField label="Contract" options={CONTRACTS} />}
                  </form.AppField>
                  <form.AppField name="prompt">
                    {(field) => (
                      <field.TextAreaField
                        label="Prompt"
                        placeholder="The job here, on top of the agent's own prompt."
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
                  <form.AppField name="wipLimit" validators={{ onChange: numberRule({ min: 1, required: true }) }}>
                    {(field) => <field.InputField label="Work at once (WIP limit)" inputMode="numeric" />}
                  </form.AppField>
                  <form.AppField name="maxAttempts" validators={{ onChange: numberRule({ min: 0, required: true }) }}>
                    {(field) => <field.InputField label="Attempts before leaving it for you" inputMode="numeric" />}
                  </form.AppField>
                </>
              )
            }
          </form.Subscribe>
          <FormDialogFooter onCancel={() => onOpenChange(false)} error={error ? describeError(error) : null}>
            <form.SubmitButton isEdit editLabel="Save" />
          </FormDialogFooter>
        </Form>
      </form.AppForm>
    </FormDialog>
  );
}
