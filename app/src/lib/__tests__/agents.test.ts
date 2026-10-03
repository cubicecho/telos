import { describe, expect, it } from 'vitest';
import { effortOptions } from '@/components/domain/ai/agent-settings-fields';
import { fromLayerDraft, toLayerDraft } from '../agents';

// Reasoning effort is a choice like tool discovery: inherit, or a level, with
// "off" a level of its own, so an agent can turn off what its defaults ask for.

describe('reasoning effort in a layer draft', () => {
  it('reads null as inherit and keeps off as a value, both ways', () => {
    expect(toLayerDraft({ reasoningEffort: null }).reasoningEffort).toBe('inherit');
    expect(toLayerDraft({ reasoningEffort: 'off' }).reasoningEffort).toBe('off');
    expect(fromLayerDraft(toLayerDraft({ reasoningEffort: null })).reasoningEffort).toBeNull();
    expect(fromLayerDraft(toLayerDraft({ reasoningEffort: 'off' })).reasoningEffort).toBe('off');
    expect(fromLayerDraft(toLayerDraft({ reasoningEffort: 'high' })).reasoningEffort).toBe('high');
  });

  it('offers min-agent’s levels, and keeps one stored that is none of them', () => {
    const values = (inherited: string, current: string) =>
      effortOptions(inherited, current).map((option) => option.value);
    expect(values('', 'inherit')).toEqual([
      'inherit',
      'off',
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(values('high', 'auto')).toContain('auto');
    expect(effortOptions('high', 'inherit')[0].label).toBe('Inherit (high)');
  });
});
