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
  drafting: [],
  stuck: new Map(),
  waiting: new Map(),
  spent: { __typename: 'RunAggregate', count: 3, sum: { __typename: 'RunSumAggregate', totalTokens: 1200 } },
  draftSpent: undefined,
  loading: false,
} as unknown as ProjectActivity;

function bar(on: boolean, project: { aiEnabled: boolean; autoRun: boolean }, activity?: ProjectActivity) {
  render(
    <MockedProvider mocks={[aiState(on)]}>
      <ProjectBar project={{ id: 'p1', ...project }} activity={activity} />
    </MockedProvider>,
  );
}

describe('ProjectBar', () => {
  it('draws nothing while AI is off for the account', async () => {
    bar(false, { aiEnabled: true, autoRun: true }, ACTIVITY);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('region', { name: 'AI on this project' })).not.toBeInTheDocument();
  });

  it('holds both switches and what the agents have spent', async () => {
    bar(true, { aiEnabled: true, autoRun: false }, ACTIVITY);
    expect(await screen.findByRole('switch', { name: 'AI works on this project' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Agents start on todos by themselves' })).not.toBeChecked();
    expect(screen.getByText('Nothing running · 3 runs and 1,200 tokens in 30 days')).toBeInTheDocument();
  });

  it('leaves auto-run out while the project’s AI is off', async () => {
    bar(true, { aiEnabled: false, autoRun: true });
    expect(await screen.findByRole('switch', { name: 'AI works on this project' })).not.toBeChecked();
    expect(screen.queryByRole('switch', { name: 'Agents start on todos by themselves' })).not.toBeInTheDocument();
  });
});
