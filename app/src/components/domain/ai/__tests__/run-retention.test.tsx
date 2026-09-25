import { MockedProvider } from '@apollo/client/testing';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RunRetentionDocument, SetRunRetentionDocument } from '@/lib/graphql';
import { RunRetention } from '../run-retention';

function retention(days: number | null) {
  return {
    request: { query: RunRetentionDocument },
    result: { data: { users: [{ __typename: 'User', id: 'u1', runRetentionDays: days }] } },
  };
}

describe('RunRetention', () => {
  it('shows what is kept, and changes it', async () => {
    const user = userEvent.setup();
    const set = vi.fn(() => ({ data: { setRunRetention: { __typename: 'User', id: 'u1', runRetentionDays: 90 } } }));
    render(
      <MockedProvider
        mocks={[retention(null), { request: { query: SetRunRetentionDocument, variables: { days: 90 } }, result: set }]}
      >
        <RunRetention />
      </MockedProvider>,
    );

    const forever = await screen.findByRole('button', { name: 'For good' });
    await vi.waitFor(() => expect(forever).toHaveAttribute('aria-pressed', 'true'));
    await user.click(screen.getByRole('button', { name: '90 days' }));
    await vi.waitFor(() => expect(set).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: '90 days' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows a number set elsewhere as itself', async () => {
    render(
      <MockedProvider mocks={[retention(14)]}>
        <RunRetention />
      </MockedProvider>,
    );
    expect(await screen.findByRole('button', { name: '14 days' })).toHaveAttribute('aria-pressed', 'true');
  });
});
