import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SettingsScreen from '../../../../../app/(app)/settings';

// Settings is tabbed: General always; AI once there is anything to switch; and
// Agents and MCP servers only with AI on, since there is nothing to set up in
// them before. A link to a tab that is not there lands on General.

const state = vi.hoisted(() => ({
  params: {} as { tab?: string },
  ai: { on: false, settings: false },
}));

vi.mock('expo-router', () => ({
  router: { setParams: vi.fn() },
  useLocalSearchParams: () => state.params,
}));
vi.mock('@/lib/ai', () => ({ useAi: () => state.ai }));
// What each tab holds has its own tests; here only which one is showing counts.
vi.mock('@/components/domain/ai/ai-settings', () => ({
  AiSettings: () => 'AI switches',
  AgentSettings: () => 'Agent settings',
}));
vi.mock('@/components/domain/ai/mcp-server-manager', () => ({ McpServerManager: () => 'MCP servers list' }));
vi.mock('@/components/domain/label/label-manager', () => ({ LabelManager: () => 'Labels' }));
vi.mock('@/components/domain/template/template-manager', () => ({ TemplateManager: () => 'Templates' }));

function open(tab: string | undefined, ai: { on: boolean; settings: boolean }) {
  state.params = tab ? { tab } : {};
  state.ai = ai;
  render(<SettingsScreen />);
}

describe('the settings tabs', () => {
  beforeEach(() => {
    state.params = {};
  });

  it('are not there at all without AI', () => {
    open('agents', { on: false, settings: false });
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.getByText(/Labels/)).toBeInTheDocument();
  });

  it('offer only General and AI while AI is off for the account', () => {
    open('agents', { on: false, settings: true });
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['General', 'AI']);
    expect(screen.getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true');
  });

  it('add Agents and MCP servers once AI is on, and open the one the link names', () => {
    open('agents', { on: true, settings: true });
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'General',
      'AI',
      'Agents',
      'MCP servers',
    ]);
    expect(screen.getByRole('tab', { name: 'Agents' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText(/Agent settings/)).toBeInTheDocument();
  });

  it('open the MCP servers tab from its link', () => {
    open('mcp', { on: true, settings: true });
    expect(screen.getByText(/MCP servers list/)).toBeInTheDocument();
  });
});
