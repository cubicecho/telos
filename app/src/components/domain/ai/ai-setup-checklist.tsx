import { useQuery } from '@apollo/client';
import { Link } from 'expo-router';
import { Text, View } from 'react-native';
import type { AiSetupQuery } from '@/__generated__/graphql';
import { Section } from '@/components/section';
import { CircleCheck } from '@/components/ui/icons';
import { useAi } from '@/lib/ai';
import { AiSetupDocument } from '@/lib/graphql';
import { RUNNER_QUIET_SECONDS } from './ai-status';
import { formatDuration } from './run-log';

/** How often the checklist asks again, so a row ticks soon after the step is taken elsewhere. */
export const SETUP_POLL_MS = 5000;

const SETTINGS_AI = '/settings?tab=ai';
const SETTINGS_AGENTS = '/settings?tab=agents';
const MS_PER_SECOND = 1000;

type Setup = AiSetupQuery['aiSetup'];

/** One row: a step, whether it is taken, and where to take it. */
export interface SetupStep {
  key: string;
  label: string;
  done: boolean;
  /** What to do about it. Shown only while the step is not taken. */
  hint: string;
  /** Where it is fixed, when that is one place. */
  href?: string | undefined;
  linkLabel?: string | undefined;
}

/**
 * How long ago the runner asked for work.
 *
 * @param seenAt - When it last did, as the server said it.
 * @param now - The time to measure from, in milliseconds.
 * @returns The seconds since, or null when it has not asked since the server started.
 */
function runnerQuietFor(seenAt: string | null | undefined, now: number): number | null {
  if (!seenAt) return null;
  return Math.max(0, Math.round((now - Date.parse(seenAt)) / MS_PER_SECOND));
}

/**
 * The steps to a first run, in the order they are taken.
 *
 * The first two are the switches the caller already read; the list is only
 * built once both are on, so they arrive ticked.
 *
 * @param setup - What the server says is in place.
 * @param projectId - The project being looked at, when the list is on one.
 * @param now - The time to measure the runner's silence from, in milliseconds.
 * @returns Every step, taken or not.
 */
export function setupSteps(setup: Setup, projectId: string | undefined, now: number): SetupStep[] {
  // The project the rows about a project send you to: the one furthest along,
  // or the one on screen while none has a lane with an agent.
  const target = setup.stationProjectIds[0] ?? projectId;
  const board = target ? `/projects/${target}?view=board` : undefined;
  const quietFor = runnerQuietFor(setup.runnerSeenAt, now);

  return [
    { key: 'instance', label: 'AI is on for this instance', done: true, hint: '' },
    { key: 'account', label: 'AI is on for your account', done: true, hint: '' },
    {
      key: 'agent',
      label: 'You have an agent',
      done: setup.agent,
      hint: 'An agent is a model behind an OpenAI-compatible endpoint. Add one in Settings.',
      href: SETTINGS_AGENTS,
      linkLabel: 'Open Settings',
    },
    {
      key: 'agent-lane',
      label: 'A lane has an agent',
      done: setup.station,
      hint: target
        ? 'An agent works the todos in its lane. Turn AI on for the project, then on its board open a lane’s menu and choose “Agent…”.'
        : 'An agent works the todos in its lane. Create a project first; its board is where a lane is given an agent.',
      href: board,
      linkLabel: 'Open the board',
    },
    {
      key: 'projectAi',
      label: 'AI is on for that project',
      done: setup.projectAi,
      hint: 'Turn on “AI works on this project”, under the project’s name.',
      href: setup.station ? board : undefined,
      linkLabel: 'Open the project',
    },
    {
      key: 'request',
      label: 'There is a first request',
      done: setup.request,
      hint: 'Add a todo to the agent’s lane, or talk a request over from the project’s header.',
      href: setup.projectAi ? board : undefined,
      linkLabel: 'Open the board',
    },
    {
      key: 'started',
      label: 'Work may start',
      done: setup.started,
      hint: 'Turn on “Agents start on todos by themselves”, or press Run now on a todo’s card.',
      href: setup.projectAi ? board : undefined,
      linkLabel: 'Open the board',
    },
    {
      key: 'runner',
      label: 'The runner is asking for work',
      done: quietFor !== null && quietFor <= RUNNER_QUIET_SECONDS,
      hint:
        quietFor === null
          ? 'It has not asked since the server started, so nothing will be picked up. It starts with the server: look in the server’s log.'
          : `It last asked ${formatDuration(quietFor)} ago and may have stopped. It starts with the server: look in the server’s log.`,
    },
  ];
}

/**
 * What still stands between this account and its first run, each step read
 * from what is there now and linking to where it is taken. Gone once every
 * step is.
 *
 * Nothing is drawn where the server offers no AI. With AI off for the instance
 * or the account there is one line offering it, and only on the home page
 * (no `projectId`): a project's page says nothing about AI to someone who
 * left it off.
 *
 * On a project it shows where the project has no lane with an agent, and on the project
 * the list points at, so the later steps have somewhere to be read. A project
 * with AI switched off shows nothing: its switch, beside it, is the one step
 * that matters there, and it was left off on purpose.
 *
 * @param projectId - The project on screen, or nothing on the home page.
 * @param projectAi - Whether that project has AI on; false hides the list.
 */
export function AiSetupChecklist({
  projectId,
  projectAi = true,
}: {
  projectId?: string | undefined;
  projectAi?: boolean;
}) {
  const ai = useAi();
  const shown = ai.on && projectAi;
  const { data } = useQuery(AiSetupDocument, {
    skip: !shown,
    pollInterval: shown ? SETUP_POLL_MS : 0,
    fetchPolicy: 'cache-and-network',
  });

  if (!ai.available) return null;
  if (!ai.on) return projectId ? null : <Offer instance={ai.instance} admin={ai.admin} />;
  if (!projectAi) return null;

  // No answer, no list: a checklist that could not be read has nothing true to say.
  const setup = data?.aiSetup;
  if (!setup) return null;

  const withAgents = setup.stationProjectIds;
  if (projectId && withAgents.includes(projectId) && withAgents[0] !== projectId) return null;

  const steps = setupSteps(setup, projectId, Date.now());
  const left = steps.filter((step) => !step.done).length;
  if (left === 0) return null;

  return (
    <Section
      surface="card"
      title="Getting AI running"
      description={`${left} of ${steps.length} steps left before an agent works a todo.`}
      contentSlot={
        <View role="list" aria-label="AI setup steps" className="gap-2">
          {steps.map((step) => (
            <View
              key={step.key}
              role="listitem"
              aria-label={`${step.label}: ${step.done ? 'done' : 'not done'}`}
              className="flex-row gap-2"
            >
              {step.done ? (
                <CircleCheck aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-positive" />
              ) : (
                <View aria-hidden className="mt-0.5 size-4 shrink-0 rounded-full border border-muted-foreground" />
              )}
              <View className="flex-1 gap-0.5">
                <Text className={step.done ? 'text-muted-foreground text-sm' : 'font-medium text-foreground text-sm'}>
                  {step.label}
                </Text>
                {step.done ? null : (
                  <Text className="text-muted-foreground text-xs">
                    {step.hint}
                    {step.href ? (
                      <>
                        {' '}
                        <Link href={step.href} className="text-foreground underline">
                          {step.linkLabel}
                        </Link>
                      </>
                    ) : null}
                  </Text>
                )}
              </View>
            </View>
          ))}
        </View>
      }
    />
  );
}

/** The one line for an account that has not turned AI on: what it is, and who can. */
function Offer({ instance, admin }: { instance: boolean; admin: boolean }) {
  if (!instance && !admin) {
    return (
      <Text className="text-muted-foreground text-sm">
        Agents can work todos for you, but AI is off on this instance. Ask an admin to turn it on.
      </Text>
    );
  }
  return (
    <Text className="text-muted-foreground text-sm">
      {instance
        ? 'Agents can work todos for you. AI is off for your account.'
        : 'Agents can work todos for you. AI is off on this instance.'}{' '}
      <Link href={SETTINGS_AI} className="text-foreground underline">
        Turn it on in Settings
      </Link>
    </Text>
  );
}
