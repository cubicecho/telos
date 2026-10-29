import { MockedProvider } from '@apollo/client/testing';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ProjectActivity } from '@/components/domain/ai/project-activity';
import { AiStateDocument } from '@/lib/graphql';
import { ProjectBar } from '../project-bar';

function aiState(on: boolean) {
  return {
    request: { query: AiStateDocument },
    result: {
      data: {
        authConfig: { __typename: 'AuthConfig', ai: on, aiAvailable: on },
        users: [{ __typename: 'User', id: 'u1', aiEnabled: on, isAdmin: false }],
      },
    },
  };
}

const ACTIVITY: ProjectActivity = {
  live: new Map(),
  stuck: new Map(),
  waiting: new Map(),
  asked: new Map(),
  spent: { __typename: 'RunAggregate', count: 3, sum: { __typename: 'RunSumAggregate', totalTokens: 1200 } },
  loading: false,
} as unknown as ProjectActivity;

function bar(on: boolean, project: { aiEnabled: boolean; runMode: string }, activity?: ProjectActivity) {
  render(
    <MockedProvider mocks={[aiState(on)]}>
      <ProjectBar project={{ id: 'p1', ...project }} activity={activity} />
    </MockedProvider>,
  );
}

describe('ProjectBar', () => {
  it('draws nothing while AI is off for the account', async () => {
    bar(false, { aiEnabled: true, runMode: 'auto' }, ACTIVITY);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('region', { name: 'AI on this project' })).not.toBeInTheDocument();
  });

  it('holds the project’s mode and what the agents have spent', async () => {
    bar(true, { aiEnabled: true, runMode: 'lane' }, ACTIVITY);
    expect(await screen.findByRole('group', { name: 'How far AI works this project' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'One lane' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Nothing running · 3 runs and 1,200 tokens in 30 days')).toBeInTheDocument();
  });

  it('counts the todos whose agent is waiting on an answer', async () => {
    const asked = new Map([
      ['t1', {}],
      ['t2', {}],
    ]) as unknown as ProjectActivity['asked'];
    bar(true, { aiEnabled: true, runMode: 'auto' }, { ...ACTIVITY, asked });
    expect(await screen.findByText('2 waiting on you ·')).toBeInTheDocument();
  });

  it('says the project is off while its AI is, whatever its run mode', async () => {
    bar(true, { aiEnabled: false, runMode: 'auto' });
    expect(await screen.findByRole('button', { name: 'Off' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Auto' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('AI is off for this project')).toBeInTheDocument();
  });
});
