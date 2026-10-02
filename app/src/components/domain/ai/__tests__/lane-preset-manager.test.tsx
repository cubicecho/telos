import { MockedProvider } from '@apollo/client/testing';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { LanePresetsDocument } from '@/lib/graphql';
import { describeOverrides, joinPrompts } from '@/lib/lane-presets';
import { deleteWarning, fromPresetDraft, LanePresetManager, toPresetDraft } from '../lane-preset-manager';

const PRESET = {
  __typename: 'LanePreset' as const,
  id: 'p1',
  name: 'Review',
  contract: 'verdict',
  prompt: 'Check the tests pass.',
  wipLimit: 2,
  maxAttempts: 5,
  lanes: [
    {
      __typename: 'Lane' as const,
      id: 'l1',
      name: 'Check',
      presetOverrides: ['wipLimit', 'contract'],
      project: { __typename: 'Project' as const, id: 'pr1', name: 'Telos' },
    },
    {
      __typename: 'Lane' as const,
      id: 'l2',
      name: 'QA',
      presetOverrides: [],
      project: { __typename: 'Project' as const, id: 'pr2', name: 'Site' },
    },
  ],
};

describe('lane presets, as the forms say them', () => {
  it('names what a lane overrides', () => {
    expect(describeOverrides([])).toBe('Follows it as it is');
    expect(describeOverrides(null)).toBe('Follows it as it is');
    expect(describeOverrides(['maxAttempts'])).toBe('Overrides attempts');
    expect(describeOverrides(['wipLimit', 'contract'])).toBe('Overrides contract and WIP limit');
    expect(describeOverrides(['maxAttempts', 'wipLimit', 'contract'])).toBe(
      'Overrides contract, WIP limit and attempts',
    );
  });

  it('puts the lane’s prompt after the preset’s', () => {
    expect(joinPrompts('Review it.', 'Mind the docs.')).toBe('Review it.\n\nMind the docs.');
    expect(joinPrompts(null, ' Mind the docs. ')).toBe('Mind the docs.');
    expect(joinPrompts('  ', '')).toBe('');
  });

  it('reads a preset into its form and back', () => {
    expect(fromPresetDraft({ ...toPresetDraft(PRESET), name: ' Review ', prompt: ' ' })).toEqual({
      name: 'Review',
      contract: 'verdict',
      prompt: null,
      wipLimit: 2,
      maxAttempts: 5,
    });
    expect(toPresetDraft(null)).toMatchObject({ contract: 'work', wipLimit: '1', maxAttempts: '3' });
  });

  it('warns that deleting copies the preset into its lanes', () => {
    expect(deleteWarning(0)).toContain('No lane follows it');
    expect(deleteWarning(1)).toContain('The 1 lane following it keeps');
    expect(deleteWarning(2)).toContain('copied into each first');
  });
});

describe('LanePresetManager', () => {
  it('lists each preset with the lanes following it and what each overrides', async () => {
    render(
      <MockedProvider
        mocks={[{ request: { query: LanePresetsDocument }, result: { data: { lanePresets: [PRESET] } } }]}
      >
        <LanePresetManager />
      </MockedProvider>,
    );
    expect(await screen.findByText('Review')).toBeInTheDocument();
    const lanes = screen.getByRole('list', { name: 'Lanes following Review' });
    expect(lanes).toHaveTextContent('Telos › Check — Overrides contract and WIP limit');
    expect(lanes).toHaveTextContent('Site › QA — Follows it as it is');
  });

  it('says what deleting a preset in use does before it does it', async () => {
    const user = userEvent.setup();
    render(
      <MockedProvider
        mocks={[{ request: { query: LanePresetsDocument }, result: { data: { lanePresets: [PRESET] } } }]}
      >
        <LanePresetManager />
      </MockedProvider>,
    );
    await user.click(await screen.findByRole('button', { name: 'Delete Review' }));
    expect(await screen.findByText(/The 2 lanes following it keep working as now/)).toBeInTheDocument();
  });
});
