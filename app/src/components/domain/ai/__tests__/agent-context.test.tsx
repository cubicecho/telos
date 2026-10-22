import { MockedProvider } from '@apollo/client/testing';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  GlobalContextDocument,
  ProjectContextsDocument,
  SetGlobalContextDocument,
  SetProjectContextDocument,
} from '@/lib/graphql';
import { ContextSettings } from '../agent-context';

const globalContext = (text: string | null) => ({
  request: { query: GlobalContextDocument },
  result: { data: { users: [{ __typename: 'User', id: 'u1', globalContext: text }] } },
});

const projects = {
  request: { query: ProjectContextsDocument },
  result: {
    data: {
      projects: [
        { __typename: 'Project', id: 'p1', name: 'Garden', aiEnabled: true, context: 'Beds and paths.' },
        { __typename: 'Project', id: 'p2', name: 'Shed', aiEnabled: false, context: null },
      ],
    },
  },
};

// biome-ignore lint/suspicious/noExplicitAny: MockedProvider's mock array type
function settings(mocks: any[]) {
  render(
    <MockedProvider mocks={mocks}>
      <ContextSettings />
    </MockedProvider>,
  );
}

describe('ContextSettings', () => {
  it('shows the global context and each project’s, saying which are closed to AI', async () => {
    settings([globalContext('Work runs on the homelab.'), projects]);

    expect(await screen.findByDisplayValue('Work runs on the homelab.')).toBeInTheDocument();
    expect(await screen.findByDisplayValue('Beds and paths.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Shed' })).toHaveValue('');
    expect(screen.getByText(/Closed to AI/)).toBeInTheDocument();
    expect(screen.getAllByText(/Agents keep (it|these) up to date too/)).toHaveLength(2);
  });

  it('saves the global context trimmed, and a project’s blank as null', async () => {
    const user = userEvent.setup();
    const setGlobal = vi.fn(() => ({
      data: { setGlobalContext: { __typename: 'User', id: 'u1', globalContext: 'Use pnpm.' } },
    }));
    const setProject = vi.fn(() => ({
      data: { updateProject: { __typename: 'Project', id: 'p1', context: null } },
    }));
    settings([
      globalContext(null),
      projects,
      { request: { query: SetGlobalContextDocument, variables: { context: 'Use pnpm.' } }, result: setGlobal },
      { request: { query: SetProjectContextDocument, variables: { id: 'p1', context: null } }, result: setProject },
    ]);

    const save = await screen.findByRole('button', { name: 'Save Global context' });
    expect(save).toBeDisabled();
    await user.type(screen.getByRole('textbox', { name: 'Global context' }), '  Use pnpm. ');
    await user.click(save);
    await waitFor(() => expect(setGlobal).toHaveBeenCalled());

    await user.clear(await screen.findByRole('textbox', { name: 'Garden' }));
    await user.click(screen.getByRole('button', { name: 'Save Garden' }));
    await waitFor(() => expect(setProject).toHaveBeenCalled());
  });
});
