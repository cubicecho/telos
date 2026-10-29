import { MockedProvider } from '@apollo/client/testing';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GraphQLError } from 'graphql';
import { describe, expect, it, vi } from 'vitest';
import { AiMode } from '@/__generated__/graphql';
import { AiStateDocument, ProjectActivityDocument, SetProjectAiModeDocument } from '@/lib/graphql';
import { useProjectActivity } from '../project-activity';
import { aiModeOf, ProjectAiModePicker } from '../project-ai-mode';

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

function setMode(aiEnabled: boolean, runMode: string) {
  return vi.fn(() => ({ data: { setProjectAiMode: { __typename: 'Project', id: 'p1', aiEnabled, runMode } } }));
}

// biome-ignore lint/suspicious/noExplicitAny: MockedProvider's mock array type
function picker(mocks: any[], project: { aiEnabled: boolean; runMode: string }) {
  render(
    <MockedProvider mocks={mocks}>
      <ProjectAiModePicker projectId="p1" {...project} />
    </MockedProvider>,
  );
}

describe('aiModeOf', () => {
  it('is off while the project’s AI is, and its run mode otherwise', () => {
    expect(aiModeOf({ aiEnabled: false, runMode: 'auto' })).toBe(AiMode.Off);
    expect(aiModeOf({ aiEnabled: true, runMode: 'auto' })).toBe(AiMode.Auto);
    expect(aiModeOf({ aiEnabled: true, runMode: 'lane' })).toBe(AiMode.Lane);
    expect(aiModeOf({ aiEnabled: true, runMode: 'follow' })).toBe(AiMode.Follow);
  });
});

describe('ProjectAiModePicker', () => {
  it('draws nothing while AI is off for the account', async () => {
    picker([aiState(false)], { aiEnabled: true, runMode: 'lane' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
  });

  it('says what the current mode does, and picks another', async () => {
    const user = userEvent.setup();
    const set = setMode(true, 'follow');
    picker(
      [
        aiState(true),
        {
          request: { query: SetProjectAiModeDocument, variables: { projectId: 'p1', mode: AiMode.Follow } },
          result: set,
        },
      ],
      { aiEnabled: true, runMode: 'lane' },
    );
    expect(await screen.findByText('Agents work a todo one lane at a time, when asked')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'One lane' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Follow' }));
    await vi.waitFor(() => expect(set).toHaveBeenCalled());
  });

  it('turns the project off', async () => {
    const user = userEvent.setup();
    const set = setMode(false, 'auto');
    picker(
      [
        aiState(true),
        { request: { query: SetProjectAiModeDocument, variables: { projectId: 'p1', mode: AiMode.Off } }, result: set },
      ],
      { aiEnabled: true, runMode: 'auto' },
    );
    await user.click(await screen.findByRole('button', { name: 'Off' }));
    await vi.waitFor(() => expect(set).toHaveBeenCalled());
  });

  it('has the board ask again where its todos stand, without waiting for the poll', async () => {
    const user = userEvent.setup();
    const activity = vi.fn(() => ({
      data: {
        work: { __typename: 'AiStatus', todos: [] },
        live: [],
        spent: { __typename: 'RunAggregate', count: 0, sum: null },
      },
    }));
    /** Holds the project's activity the way the project page does. */
    function Page() {
      useProjectActivity('p1');
      return <ProjectAiModePicker projectId="p1" aiEnabled runMode="lane" />;
    }
    render(
      <MockedProvider
        mocks={[
          aiState(true),
          {
            request: { query: ProjectActivityDocument },
            variableMatcher: () => true,
            result: activity,
            maxUsageCount: 5,
          },
          {
            request: { query: SetProjectAiModeDocument, variables: { projectId: 'p1', mode: AiMode.Auto } },
            result: setMode(true, 'auto'),
          },
        ]}
      >
        <Page />
      </MockedProvider>,
    );
    await vi.waitFor(() => expect(activity).toHaveBeenCalledTimes(1));
    await user.click(await screen.findByRole('button', { name: 'Auto' }));
    await vi.waitFor(() => expect(activity).toHaveBeenCalledTimes(2));
  });

  it('says why the mode could not be changed', async () => {
    const user = userEvent.setup();
    picker(
      [
        aiState(true),
        {
          request: { query: SetProjectAiModeDocument, variables: { projectId: 'p1', mode: AiMode.Lane } },
          result: { errors: [new GraphQLError('Project not found')] },
        },
      ],
      { aiEnabled: true, runMode: 'auto' },
    );
    expect(await screen.findByText('Agents start on todos by themselves')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'One lane' }));
    expect(await screen.findByText('Project not found')).toBeInTheDocument();
  });
});
