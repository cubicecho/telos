import { MockedProvider } from '@apollo/client/testing';
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { AiSetupDocument, AiStateDocument } from '@/lib/graphql';
import { AiSetupChecklist, setupSteps } from '../ai-setup-checklist';

vi.mock('expo-router', () => ({
  Link: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

function aiState({ available = true, instance = true, account = true, admin = false } = {}) {
  return {
    request: { query: AiStateDocument },
    result: {
      data: {
        authConfig: { __typename: 'AuthConfig', ai: instance, aiAvailable: available },
        users: [{ __typename: 'User', id: 'u1', aiEnabled: account, isAdmin: admin }],
      },
    },
  };
}

const NOTHING = {
  __typename: 'AiSetup' as const,
  agent: false,
  station: false,
  stationProjectIds: [] as string[],
  projectAi: false,
  request: false,
  started: false,
  runnerSeenAt: null as string | null,
};

function everything() {
  return {
    ...NOTHING,
    agent: true,
    station: true,
    stationProjectIds: ['p1'],
    projectAi: true,
    request: true,
    started: true,
    runnerSeenAt: new Date().toISOString(),
  };
}

function aiSetup(setup: typeof NOTHING) {
  const result = vi.fn(() => ({ data: { aiSetup: setup } }));
  return { request: { query: AiSetupDocument }, result, maxUsageCount: Number.POSITIVE_INFINITY };
}

// biome-ignore lint/suspicious/noExplicitAny: MockedProvider's mock array type
function checklist(mocks: any[], projectId?: string) {
  render(
    <MockedProvider mocks={mocks}>
      <AiSetupChecklist projectId={projectId} />
    </MockedProvider>,
  );
}

/** Long enough for the mocked answers to land, for the tests that expect nothing drawn. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

function row(name: string) {
  return within(screen.getByRole('list', { name: 'AI setup steps' })).getByRole('listitem', { name });
}

describe('AiSetupChecklist', () => {
  it('draws nothing, and asks nothing, where the server offers no AI', async () => {
    const setup = aiSetup(NOTHING);
    checklist([aiState({ available: false, instance: false, account: false, admin: true }), setup]);
    await settle();
    expect(document.body).toHaveTextContent('');
    expect(setup.result).not.toHaveBeenCalled();
  });

  it('offers AI in one line to an account that left it off, without the list', async () => {
    const setup = aiSetup(NOTHING);
    checklist([aiState({ account: false }), setup]);
    expect(await screen.findByText(/AI is off for your account/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Turn it on in Settings' })).toHaveAttribute('href', '/settings');
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(setup.result).not.toHaveBeenCalled();
  });

  it('sends an admin to Settings while the instance has AI off', async () => {
    checklist([aiState({ instance: false, account: false, admin: true })]);
    expect(await screen.findByText(/AI is off on this instance/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Turn it on in Settings' })).toBeInTheDocument();
  });

  it('tells everyone else to ask an admin', async () => {
    checklist([aiState({ instance: false, account: false })]);
    expect(await screen.findByText(/Ask an admin to turn it on/)).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('says nothing on a project to an account that left AI off', async () => {
    checklist([aiState({ account: false })], 'p1');
    await settle();
    expect(document.body).toHaveTextContent('');
  });

  it('lists every step, the two switches ticked, and where the next is taken', async () => {
    checklist([aiState(), aiSetup(NOTHING)]);
    expect(await screen.findByText('6 of 8 steps left before an agent works a todo.')).toBeInTheDocument();
    expect(row('AI is on for this instance: done')).toBeInTheDocument();
    expect(row('AI is on for your account: done')).toBeInTheDocument();
    const agent = row('You have an agent: not done');
    expect(within(agent).getByRole('link', { name: 'Open Settings' })).toHaveAttribute('href', '/settings');
    // No project yet, so no board to send anyone to.
    expect(within(row('A project has a station: not done')).queryByRole('link')).not.toBeInTheDocument();
    expect(row('The runner is asking for work: not done')).toHaveTextContent('has not asked since the server started');
  });

  it('points the station step at the project on screen while none has one', async () => {
    checklist([aiState(), aiSetup({ ...NOTHING, agent: true })], 'p9');
    const station = await screen.findByRole('listitem', { name: 'A project has a station: not done' });
    expect(within(station).getByRole('link', { name: 'Open the board' })).toHaveAttribute(
      'href',
      '/projects/p9?view=board',
    );
    expect(row('You have an agent: done')).not.toHaveTextContent('Open Settings');
  });

  it('points the later steps at the project furthest along', async () => {
    checklist(
      [
        aiState(),
        aiSetup({ ...NOTHING, agent: true, station: true, stationProjectIds: ['p1', 'p2'], projectAi: true }),
      ],
      'p9',
    );
    const request = await screen.findByRole('listitem', { name: 'There is a first request: not done' });
    expect(within(request).getByRole('link')).toHaveAttribute('href', '/projects/p1?view=board');
  });

  it('shows on the project it points at, and not on another that has a station', async () => {
    const setup = { ...NOTHING, agent: true, station: true, stationProjectIds: ['p1', 'p2'] };
    checklist([aiState(), aiSetup(setup)], 'p1');
    expect(await screen.findByRole('list', { name: 'AI setup steps' })).toBeInTheDocument();
  });

  it('is absent from a project with a station that the list does not point at', async () => {
    const setup = aiSetup({ ...NOTHING, agent: true, station: true, stationProjectIds: ['p1', 'p2'] });
    checklist([aiState(), setup], 'p2');
    await vi.waitFor(() => expect(setup.result).toHaveBeenCalled());
    await settle();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('is gone once every step is taken', async () => {
    const setup = aiSetup(everything());
    checklist([aiState(), setup]);
    await vi.waitFor(() => expect(setup.result).toHaveBeenCalled());
    await settle();
    expect(document.body).toHaveTextContent('');
  });

  it('comes back when everything is in place but the runner has gone quiet', async () => {
    const quiet = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    checklist([aiState(), aiSetup({ ...everything(), runnerSeenAt: quiet })]);
    expect(await screen.findByText('1 of 8 steps left before an agent works a todo.')).toBeInTheDocument();
    expect(row('The runner is asking for work: not done')).toHaveTextContent('may have stopped');
  });
});

describe('setupSteps', () => {
  const now = Date.parse('2026-01-01T00:10:00Z');

  it('counts the runner as there only while it asked within the last minute', () => {
    const runner = (runnerSeenAt: string | null) =>
      setupSteps({ ...NOTHING, runnerSeenAt }, undefined, now).find((step) => step.key === 'runner');
    expect(runner('2026-01-01T00:09:30Z')?.done).toBe(true);
    expect(runner('2026-01-01T00:08:00Z')?.done).toBe(false);
    expect(runner(null)?.done).toBe(false);
  });

  it('links a project step only once the step before it has a project to name', () => {
    const steps = setupSteps({ ...NOTHING, agent: true }, 'p9', now);
    const href = (key: string) => steps.find((step) => step.key === key)?.href;
    expect(href('station')).toBe('/projects/p9?view=board');
    expect(href('projectAi')).toBeUndefined();
    expect(href('request')).toBeUndefined();
  });
});
