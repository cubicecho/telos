import { useMutation, useQuery } from '@apollo/client';
import { useEffect, useMemo } from 'react';
import { Text } from 'react-native';
import type { LaneAgentFieldsFragment } from '@/__generated__/graphql';
import { useAppForm } from '@/components/app-form';
import { DialogLayout } from '@/components/dialog-layout';
import type { LaneSummary } from '@/components/domain/lane/lane-badge';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Form } from '@/components/ui/form';
import { numberRule } from '@/lib/agents';
import { describeError } from '@/lib/errors';
import { AgentDefaultsDocument, UpdateLaneAgentDocument } from '@/lib/graphql';

/** "No agent" and "stay here", as a select can hold them: radix refuses an empty value. */
const NONE = 'none';

/** A check in place of an agent: the lane runs a command, and its exit code rules. */
const CHECK = 'check';

/** "Archive it" among the lanes a success can send a todo to: one answer, never both. */
const ARCHIVE = 'archive';

/** A new lane's agent works one todo at a time. */
const DEFAULT_WIP_LIMIT = 1;

/**
 * What a person is told before a lane runs a command. It is a shell command on
 * another machine, with that machine's rights, so the copy says so plainly.
 */
const CHECK_WARNING =
  'Runs as a shell command on the runner’s host, in its working directory, with its rights. ' +
  'Exit 0 passes the todo; anything else fails it. The runner refuses checks unless RUNNER_ALLOW_STDIO is set there. ' +
  'Every check shares that one directory, so a check lane works one todo at a time.';

/** The longest a lane may let its check run: the server's own bound (LANE_CHECK_DEFAULTS). */
const MAX_CHECK_SECONDS = 3600;

/** A new lane's agent tries a todo three times before leaving it for a person. */
const DEFAULT_MAX_ATTEMPTS = 3;

export interface LaneAgentChoice {
  id: string;
  name: string;
  /** Its own model; null inherits the account's. */
  model?: string | null;
}

export interface LaneAgentDraft {
  /** An agent's id, `CHECK` or `NONE`. */
  agentId: string;
  checkCommand: string;
  /** Blank is the runner's default. */
  checkTimeoutSeconds: string;
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
export function toDraft(lane: LaneAgentFieldsFragment | null): LaneAgentDraft {
  return {
    agentId: lane?.checkCommand ? CHECK : (lane?.agentId ?? NONE),
    checkCommand: lane?.checkCommand ?? '',
    checkTimeoutSeconds: lane?.checkTimeoutSeconds == null ? '' : String(lane.checkTimeoutSeconds),
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
 * An agent and a check are too: a lane has one or the other, and a check
 * works one todo at a time, since every check runs in the runner's one
 * directory.
 *
 * @param value - The form's values.
 * @returns The columns for `updateLane`.
 */
export function toLaneAgentSet(value: LaneAgentDraft) {
  const archives = value.onSuccess === ARCHIVE;
  const checks = value.agentId === CHECK;
  return {
    agentId: checks ? null : orNone(value.agentId),
    checkCommand: checks ? value.checkCommand.trim() : null,
    checkTimeoutSeconds: checks && value.checkTimeoutSeconds.trim() ? Number(value.checkTimeoutSeconds) : null,
    onSuccessLaneId: archives ? null : orNone(value.onSuccess),
    archiveOnSuccess: archives,
    onFailureLaneId: orNone(value.onFailureLaneId),
    wipLimit: checks ? 1 : Number(value.wipLimit),
    maxAttempts: Number(value.maxAttempts),
  };
}

/** Two lanes in a review loop that work with one model. */
export interface SameModelReview {
  /** The lane that rules on the work. */
  reviewer: string;
  /** The lane whose work it rules on. */
  worker: string;
  model: string;
}

/**
 * Where the lane being edited sits in a review loop whose two ends use the
 * same model. A lane reviews work when its failure route goes back to a lane
 * whose success route leads to it: the rule `assignmentFor` (server
 * `runs/resolvers.ts`) uses to keep the worker's report from it. A judge leans
 * toward its own model's work, so the loop is worth a warning, not a refusal.
 *
 * @param laneId - The lane being edited.
 * @param draft - Its form's values, which stand in for its saved routes.
 * @param laneAgents - Every lane's agent and routes, as saved.
 * @param lanes - The board's lanes, for their names.
 * @param modelOf - The model an agent runs with, its own or the account's; null for none.
 * @returns The loops, the edited lane as reviewer first; none when the models differ.
 */
export function sameModelReviews(
  laneId: string,
  draft: LaneAgentDraft,
  laneAgents: readonly LaneAgentFieldsFragment[],
  lanes: readonly LaneSummary[],
  modelOf: (agentId: string) => string | null,
): SameModelReview[] {
  const routes = new Map<string, Pick<LaneAgentFieldsFragment, 'agentId' | 'onSuccessLaneId' | 'onFailureLaneId'>>(
    laneAgents.map((row) => [row.id, row]),
  );
  routes.set(laneId, toLaneAgentSet(draft));
  const nameOf = (id: string) => lanes.find((lane) => lane.id === id)?.name ?? '';
  const modelIn = (id: string) => {
    const agentId = routes.get(id)?.agentId;
    return agentId ? modelOf(agentId) : null;
  };
  // The edited lane as the reviewer, and as the worker its success route feeds.
  const reviewers = [laneId, routes.get(laneId)?.onSuccessLaneId].filter((id): id is string => !!id);
  return reviewers.flatMap((reviewer) => {
    const worker = routes.get(reviewer)?.onFailureLaneId;
    if (!worker || routes.get(worker)?.onSuccessLaneId !== reviewer || ![reviewer, worker].includes(laneId)) {
      return [];
    }
    const model = modelIn(reviewer);
    return model && model === modelIn(worker) ? [{ reviewer: nameOf(reviewer), worker: nameOf(worker), model }] : [];
  });
}

/**
 * A lane's agent: which agent works the todos that arrive in the lane, or the
 * check command that rules on them instead, and where each goes when its run
 * succeeds or fails.
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
  laneAgents = [],
  agents,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lane: LaneSummary;
  lanes: readonly LaneSummary[];
  settings: LaneAgentFieldsFragment | null;
  /** Every lane's agent and routes, to tell whether this one is in a review loop. */
  laneAgents?: readonly LaneAgentFieldsFragment[];
  agents: readonly LaneAgentChoice[];
}) {
  const [updateLane, { error }] = useMutation(UpdateLaneAgentDocument);
  // What an agent with no model of its own runs with.
  const defaultModel = useQuery(AgentDefaultsDocument).data?.agentDefaults.resolved.model || null;
  const modelOf = (agentId: string) => agents.find((agent) => agent.id === agentId)?.model || defaultModel;
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
    ...agents.map((a) => ({ value: a.id, label: a.name, group: 'Agents' })),
    { separator: true as const },
    { value: CHECK, label: 'A check command' },
  ];
  const otherLanes = lanes.filter((row) => row.id !== lane.id).map((row) => ({ value: row.id, label: row.name }));
  const failureOptions = [{ value: NONE, label: 'Stay here' }, ...otherLanes];
  const successOptions = [
    { value: NONE, label: 'Stay here' },
    { value: ARCHIVE, label: 'Archive it — done, and off the board' },
    ...otherLanes.map((row) => ({ ...row, label: `Move to ${row.label}` })),
  ];

  return (
    <form.AppForm>
      <DialogLayout
        open={open}
        onOpenChange={onOpenChange}
        title={`${lane.name}’s agent`}
        description="An agent, or a check command, works each todo that arrives here, then sends it on."
        size="md"
        hasUnsavedChanges={() => !form.state.isDefaultValue}
        footerSlot={
          error ? (
            <Text role="alert" className="text-negative text-sm">
              {describeError(error)}
            </Text>
          ) : null
        }
        footerActionsSlot={(close) => (
          <>
            <Button variant="outline" onPress={close} content="Cancel" />
            <form.SubmitButton isEdit editLabel="Save" />
          </>
        )}
        contentSlot={
          <Form className="gap-4">
            <form.AppField name="agentId">
              {(field) => <field.SelectField label="Agent" options={agentOptions} />}
            </form.AppField>
            {agents.length === 0 ? (
              <Text className="text-foreground/60 text-xs">Add an agent in Settings → Agents first.</Text>
            ) : null}
            <form.Subscribe selector={(state) => state.values.agentId}>
              {(agentId) =>
                agentId === NONE ? null : (
                  <>
                    {agentId === CHECK ? (
                      <>
                        <form.AppField
                          name="checkCommand"
                          validators={{
                            onChange: ({ value }) => (value.trim() ? undefined : 'A check needs a command.'),
                          }}
                        >
                          {(field) => (
                            <field.TextAreaField
                              label="Command"
                              placeholder="npm test"
                              rows={2}
                              required
                              description={CHECK_WARNING}
                            />
                          )}
                        </form.AppField>
                        <form.AppField
                          name="checkTimeoutSeconds"
                          validators={{ onChange: numberRule({ min: 1, max: MAX_CHECK_SECONDS }) }}
                        >
                          {(field) => (
                            <field.InputField
                              label="Time limit, in seconds"
                              placeholder="The runner's default"
                              inputMode="numeric"
                            />
                          )}
                        </form.AppField>
                      </>
                    ) : null}
                    <form.AppField name="onSuccess">
                      {(field) => <field.SelectField label="On success" options={successOptions} />}
                    </form.AppField>
                    <form.AppField name="onFailureLaneId">
                      {(field) => <field.SelectField label="On failure, move to" options={failureOptions} />}
                    </form.AppField>
                    {agentId === CHECK ? null : (
                      <form.AppField name="wipLimit" validators={{ onChange: numberRule({ min: 1, required: true }) }}>
                        {(field) => <field.InputField label="Work at once (WIP limit)" inputMode="numeric" />}
                      </form.AppField>
                    )}
                    <form.AppField name="maxAttempts" validators={{ onChange: numberRule({ min: 0, required: true }) }}>
                      {(field) => <field.InputField label="Attempts before leaving it for you" inputMode="numeric" />}
                    </form.AppField>
                  </>
                )
              }
            </form.Subscribe>
            <form.Subscribe selector={(state) => state.values}>
              {(values) =>
                sameModelReviews(lane.id, values, laneAgents, lanes, modelOf).map((loop) => (
                  <Alert
                    key={`${loop.reviewer}-${loop.worker}`}
                    variant="warning"
                    title="The reviewer uses the worker’s model"
                    description={`${loop.reviewer} rules on ${loop.worker}’s work with ${loop.model}, the model that did it. A model tends to favour its own work, so a different model on one of them makes the review more independent.`}
                  />
                ))
              }
            </form.Subscribe>
          </Form>
        }
      />
    </form.AppForm>
  );
}
