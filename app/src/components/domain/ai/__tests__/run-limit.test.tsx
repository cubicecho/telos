import { MockedProvider } from '@apollo/client/testing';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { InstanceRunLimitDocument, SetInstanceRunLimitDocument } from '@/lib/graphql';
import { RunLimit } from '../run-limit';

function limit(value: number) {
  return { request: { query: InstanceRunLimitDocument }, result: { data: { instanceRunLimit: value } } };
}

describe('RunLimit', () => {
  it('shows how many runs work at once, and changes it', async () => {
    const user = userEvent.setup();
    const set = vi.fn(() => ({ data: { setInstanceRunLimit: 4 } }));
    render(
      <MockedProvider
        mocks={[limit(2), { request: { query: SetInstanceRunLimitDocument, variables: { limit: 4 } }, result: set }]}
      >
        <RunLimit />
      </MockedProvider>,
    );

    const two = await screen.findByRole('button', { name: '2' });
    await vi.waitFor(() => expect(two).toHaveAttribute('aria-pressed', 'true'));
    await user.click(screen.getByRole('button', { name: '4' }));
    await vi.waitFor(() => expect(set).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: '4' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows a number set elsewhere as itself', async () => {
    render(
      <MockedProvider mocks={[limit(12)]}>
        <RunLimit />
      </MockedProvider>,
    );
    expect(await screen.findByRole('button', { name: '12' })).toHaveAttribute('aria-pressed', 'true');
  });
});
