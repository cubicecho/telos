import { MockedProvider } from '@apollo/client/testing';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GraphQLError } from 'graphql';
import { describe, expect, it, vi } from 'vitest';
import { AiStateDocument, ProjectActivityDocument, SetProjectAutoRunDocument } from '@/lib/graphql';
import { useProjectActivity } from '../project-activity';
import { ProjectAutoRunSwitch } from '../project-ai-switch';

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

// biome-ignore lint/suspicious/noExplicitAny: MockedProvider's mock array type
function autoRun(mocks: any[], enabled: boolean) {
  render(
    <MockedProvider mocks={mocks}>
      <ProjectAutoRunSwitch projectId="p1" enabled={enabled} />
    </MockedProvider>,
  );
}

describe('ProjectAutoRunSwitch', () => {
  it('draws nothing while AI is off for the account', async () => {
    autoRun([aiState(false)], false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('says the stations wait to be asked, and switches auto-run on', async () => {
    const user = userEvent.setup();
    const set = vi.fn(() => ({ data: { setProjectAutoRun: { __typename: 'Project', id: 'p1', autoRun: true } } }));
    autoRun(
      [
        aiState(true),
        { request: { query: SetProjectAutoRunDocument, variables: { projectId: 'p1', enabled: true } }, result: set },
      ],
      false,
    );
    expect(await screen.findByText('Stations wait to be asked')).toBeInTheDocument();
    const toggle = screen.getByRole('switch', { name: 'Stations start on todos by themselves' });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    await vi.waitFor(() => expect(set).toHaveBeenCalled());
  });

  it('has the board ask again where its todos stand, without waiting for the poll', async () => {
    const user = userEvent.setup();
    const activity = vi.fn(() => ({
      data: {
        stations: { __typename: 'AiStatus', todos: [] },
        live: [],
        spent: { __typename: 'RunAggregate', count: 0, sum: null },
        draftSpent: { __typename: 'RunAggregate', count: 0, sum: null },
      },
    }));
    /** Holds the project's activity the way the project page does. */
    function Page() {
      useProjectActivity('p1');
      return <ProjectAutoRunSwitch projectId="p1" enabled={false} />;
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
            request: { query: SetProjectAutoRunDocument, variables: { projectId: 'p1', enabled: true } },
            result: { data: { setProjectAutoRun: { __typename: 'Project', id: 'p1', autoRun: true } } },
          },
        ]}
      >
        <Page />
      </MockedProvider>,
    );
    await vi.waitFor(() => expect(activity).toHaveBeenCalledTimes(1));
    await user.click(await screen.findByRole('switch'));
    await vi.waitFor(() => expect(activity).toHaveBeenCalledTimes(2));
  });

  it('says why auto-run could not be switched', async () => {
    const user = userEvent.setup();
    autoRun(
      [
        aiState(true),
        {
          request: { query: SetProjectAutoRunDocument, variables: { projectId: 'p1', enabled: false } },
          result: { errors: [new GraphQLError('Project not found')] },
        },
      ],
      true,
    );
    expect(await screen.findByText('Stations start on todos by themselves')).toBeInTheDocument();
    await user.click(screen.getByRole('switch'));
    expect(await screen.findByText('Project not found')).toBeInTheDocument();
  });
});
