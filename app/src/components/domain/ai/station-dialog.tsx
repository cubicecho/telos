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

const CONTRACTS = [
  { value: 'work', label: 'Work — do the job, then move it on' },
  { value: 'verdict', label: 'Verdict — judge it: pass or fail' },
  { value: 'expand', label: 'Expand — break it into new todos' },
] as const;

export interface StationAgent {
  id: string;
  name: string;
}

interface StationDraft {
  agentId: string;
  contract: string;
  prompt: string;
  onSuccessLaneId: string;
  onFailureLaneId: string;
  wipLimit: string;
  maxAttempts: string;
}

function toDraft(station: StationFieldsFragment | null): StationDraft {
  return {
    agentId: station?.agentId ?? NONE,
    contract: station?.contract ?? 'work',
    prompt: station?.prompt ?? '',
    onSuccessLaneId: station?.onSuccessLaneId ?? NONE,
    onFailureLaneId: station?.onFailureLaneId ?? NONE,
    wipLimit: String(station?.wipLimit ?? 1),
    maxAttempts: String(station?.maxAttempts ?? 3),
  };
}

const orNone = (value: string) => (value === NONE ? null : value);

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
          set: {
            agentId: orNone(value.agentId),
            contract: value.contract,
            prompt: value.prompt.trim() === '' ? null : value.prompt.trim(),
            onSuccessLaneId: orNone(value.onSuccessLaneId),
            onFailureLaneId: orNone(value.onFailureLaneId),
            wipLimit: Number(value.wipLimit),
            maxAttempts: Number(value.maxAttempts),
          },
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
  const laneOptions = [
    { value: NONE, label: 'Stay here' },
    ...lanes.filter((row) => row.id !== lane.id).map((row) => ({ value: row.id, label: row.name })),
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
            <Text className="text-muted-foreground text-xs">Add an agent in Settings first.</Text>
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
                    name="onSuccessLaneId"
                    validators={{
                      onChangeListenTo: ['contract'],
                      onChange: ({ value, fieldApi }) =>
                        fieldApi.form.getFieldValue('contract') === 'expand' && value === NONE
                          ? 'An expand station needs somewhere to send what it adds.'
                          : undefined,
                    }}
                  >
                    {(field) => <field.SelectField label="On success, move to" options={laneOptions} />}
                  </form.AppField>
                  <form.AppField name="onFailureLaneId">
                    {(field) => <field.SelectField label="On failure, move to" options={laneOptions} />}
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
