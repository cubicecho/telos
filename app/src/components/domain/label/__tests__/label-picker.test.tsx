import { MockedProvider } from '@apollo/client/testing';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LabelsDocument } from '@/lib/graphql';
import { LabelPicker } from '../label-picker';

const URGENT = { __typename: 'Label', id: 'l1', name: 'urgent', color: '#b91c1c' };
const LATER = { __typename: 'Label', id: 'l2', name: 'later', color: '#2563eb' };

describe('LabelPicker', () => {
  it('ticks what is attached, says which was toggled, and stays open for the next', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <MockedProvider mocks={[{ request: { query: LabelsDocument }, result: { data: { labels: [URGENT, LATER] } } }]}>
        <LabelPicker attached={[URGENT]} onToggle={onToggle} />
      </MockedProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Labels' }));
    const urgent = await screen.findByRole('menuitemcheckbox', { name: 'urgent' });
    expect(urgent).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('menuitemcheckbox', { name: 'later' })).toHaveAttribute('aria-checked', 'false');

    await user.click(screen.getByRole('menuitemcheckbox', { name: 'later' }));
    expect(onToggle).toHaveBeenCalledWith(LATER, true);
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'urgent' }));
    expect(onToggle).toHaveBeenLastCalledWith(URGENT, false);
  });
});
