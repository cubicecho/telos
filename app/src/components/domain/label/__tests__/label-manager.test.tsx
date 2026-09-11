import { MockedProvider } from '@apollo/client/testing';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { DeleteLabelDocument, LabelsDocument } from '@/lib/graphql';
import { LabelManager } from '../label-manager';

const URGENT = { __typename: 'Label', id: 'l1', name: 'urgent', color: '#b91c1c' };

// biome-ignore lint/suspicious/noExplicitAny: MockedProvider's mock array type
function manager(mocks: any[]) {
  render(
    <MockedProvider mocks={mocks}>
      <LabelManager />
    </MockedProvider>,
  );
}

const listed = (labels: unknown[]) => ({
  request: { query: LabelsDocument },
  result: { data: { labels } },
});

describe('LabelManager', () => {
  it('says the server has none only when the server said none', async () => {
    manager([listed([])]);
    expect(await screen.findByText('No labels yet.')).toBeInTheDocument();
  });

  it('says the load failed instead of claiming there are none', async () => {
    // The rule this whole surface exists for: an empty state means the server
    // said "none", never that we failed to ask. Before this, a stopped API
    // rendered "No labels yet." — a confident claim about the caller's own
    // data, made by code that had not heard back.
    manager([{ request: { query: LabelsDocument }, error: new Error('Failed to fetch') }]);

    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t reach the server.');
    expect(screen.queryByText('No labels yet.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('recovers on Retry without a reload', async () => {
    const user = userEvent.setup();
    manager([{ request: { query: LabelsDocument }, error: new Error('Failed to fetch') }, listed([URGENT])]);

    await user.click(await screen.findByRole('button', { name: /retry/i }));

    expect(await screen.findByText('urgent')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('surfaces a refused delete instead of swallowing it', async () => {
    const user = userEvent.setup();
    manager([
      listed([URGENT]),
      {
        request: { query: DeleteLabelDocument, variables: { id: URGENT.id } },
        result: { errors: [{ message: 'That label is not yours.' }] },
      },
    ]);

    await user.click(await screen.findByRole('button', { name: 'Delete urgent' }));
    await user.click(await screen.findByRole('button', { name: 'Delete' }));

    // Outside the dialog on purpose: the dialog closes on the failure, and an
    // error that vanishes with the thing that caused it was never read.
    expect(await screen.findByText('That label is not yours.')).toBeInTheDocument();
  });
});
