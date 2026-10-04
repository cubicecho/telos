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

/** "Archive it" among the lanes a success can send a todo to: one answer, never both. */
const ARCHIVE = 'archive';

/** A new lane's agent works one todo at a time. */
const DEFAULT_WIP_LIMIT = 1;

/** A new lane's agent tries a todo three times before leaving it for a person. */
const DEFAULT_MAX_ATTEMPTS = 3;

export interface LaneAgentChoice {
  id: string;
  name: string;
}

export interface LaneAgentDraft {
  agentId: string;
  /** A lane's id, `ARCHIVE` or `NONE`. */
  onSuccess: string;
  onFailureLaneId: string;
  wipLimit: string;
  maxAttempts: string;
}

/**
 * Reads a lane's agent and routes into what the form holds.
 *
 * @param lane - The lane's agent settings, or null before they load.
 * @returns The form's values.
 */
export function toDraft(lane: StationFieldsFragment | null): LaneAgentDraft {
  return {
    agentId: lane?.agentId ?? NONE,
    onSuccess: lane?.archiveOnSuccess ? ARCHIVE : (lane?.onSuccessLaneId ?? NONE),
    onFailureLaneId: lane?.onFailureLaneId ?? NONE,
    wipLimit: String(lane?.wipLimit ?? DEFAULT_WIP_LIMIT),
    maxAttempts: String(lane?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS),
  };
}

const orNone = (value: string) => (value === NONE ? null : value);

/**
 * Turns the form's values into the lane columns to write. Archiving and the
 * success route are written together, so choosing one always clears the other.
 *
 * @param value - The form's values.
 * @returns The columns for `updateLane`.
 */
export function toLaneAgentSet(value: LaneAgentDraft) {
  const archives = value.onSuccess === ARCHIVE;
  return {
    agentId: orNone(value.agentId),
    onSuccessLaneId: archives ? null : orNone(value.onSuccess),
    archiveOnSuccess: archives,
    onFailureLaneId: orNone(value.onFailureLaneId),
    wipLimit: Number(value.wipLimit),
    maxAttempts: Number(value.maxAttempts),
  };
}

/**
 * A lane's agent: which agent works the todos that arrive in the lane, and
 * where each goes when its run succeeds or fails.
 *
 * No agent means an ordinary lane. The other settings are kept when the agent
 * is taken away, so putting one back restores the lane as it was.
 */
export function LaneAgentDialog({
  open,
  onOpenChange,
  lane,
  lanes,
  settings,
  agents,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lane: LaneSummary;
  lanes: readonly LaneSummary[];
  settings: StationFieldsFragment | null;
  agents: readonly LaneAgentChoice[];
}) {
  const [updateLane, { error }] = useMutation(UpdateStationDocument);
  const initial = useMemo(() => toDraft(settings), [settings]);
  const form = useAppForm({
    defaultValues: initial,
    onSubmit: ({ value }) => save(value),
  });

  useEffect(() => {
    if (open) {
      form.reset(initial);
    }
  }, [open, initial, form]);

  async function save(value: LaneAgentDraft) {
    try {
      await updateLane({ variables: { id: lane.id, set: toLaneAgentSet(value) } });
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
      title={`${lane.name}’s agent`}
      description="An agent works each todo that arrives here, then sends it on."
      className="sm:max-w-[520px]"
    >
      <form.AppForm>
        <Form className="gap-4">
          <form.AppField name="agentId">
            {(field) => <field.SelectField label="Agent" options={agentOptions} />}
          </form.AppField>
          {agents.length === 0 ? (
            <Text className="text-muted-foreground text-xs">Add an agent in Settings → Agents first.</Text>
          ) : null}
          <form.Subscribe selector={(state) => state.values.agentId}>
            {(agentId) =>
              agentId === NONE ? null : (
                <>
                  <form.AppField name="onSuccess">
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
