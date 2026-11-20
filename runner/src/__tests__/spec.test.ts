import { AGENT_DEFAULTS, AGENT_SPEC, NO_KEY } from '@cubicecho/agent-core';
import { describe, expect, it } from 'vitest';
import { keyFor, remoteAgentConfig, resolveAgent, specLayer, unrunnable } from '../spec.ts';

// An agent says only what is different about it; the account's defaults fill
// the rest, and agent-core's own fill what neither says.

const DEFAULTS = {
  baseUrl: 'http://llm.local/v1',
  model: 'qwen',
  apiKey: 'default-key',
  temperature: 0.4,
  maxTokens: 2048,
  requestTimeoutSeconds: 120,
  maxRetries: 2,
  toolDiscovery: true,
  toolSelectModel: 'tiny',
};

describe('resolveAgent', () => {
  it('inherits what the agent leaves null, and keeps what it says', () => {
    const { config, warnings } = resolveAgent(DEFAULTS, { model: 'llama', maxRetries: null });
    expect(warnings).toEqual([]);
    expect(config).toMatchObject({
      baseUrl: 'http://llm.local/v1',
      model: 'llama',
      temperature: 0.4,
      maxTokens: 2048,
      requestTimeoutSeconds: 120,
      maxRetries: 2,
      toolDiscovery: 'ondemand',
      toolSelectModel: 'tiny',
      maxToolIterations: AGENT_DEFAULTS.maxToolIterations,
    });
  });

  it('reads zero and off as values, not as "inherit"', () => {
    const { config } = resolveAgent(DEFAULTS, { temperature: 0, maxTokens: 0, maxRetries: 0, toolDiscovery: false });
    expect(config).toMatchObject({ temperature: 0, maxTokens: 0, maxRetries: 0, toolDiscovery: 'eager' });
  });

  it('passes a reasoning effort down, and lets an agent turn a default one off', () => {
    const effort = { ...DEFAULTS, reasoningEffort: 'high' };
    expect(resolveAgent(effort, {}).config.reasoningEffort).toBe('high');
    expect(resolveAgent(effort, { reasoningEffort: null }).config.reasoningEffort).toBe('high');
    expect(resolveAgent(effort, { reasoningEffort: 'off' }).config.reasoningEffort).toBe('off');
    expect(resolveAgent(DEFAULTS, {}).config.reasoningEffort).toBeUndefined();
  });

  it('passes a reasoning replay down, and lets an agent say otherwise', () => {
    const replay = { ...DEFAULTS, reasoningReplay: 'tool-loop' };
    expect(resolveAgent(replay, {}).config.reasoningReplay).toBe('tool-loop');
    expect(resolveAgent(replay, { reasoningReplay: 'none' }).config.reasoningReplay).toBe('none');
    // Unsaid, agent-core's own default ("all") applies in the loop.
    expect(resolveAgent(DEFAULTS, {}).config.reasoningReplay).toBeUndefined();
    const { warnings } = resolveAgent(DEFAULTS, { reasoningReplay: 'some' });
    expect(warnings[0]).toMatch(/^agent: model\.reasoningReplay/);
  });

  it('falls back to agent-core when nothing says anything', () => {
    const { config } = resolveAgent(null, { baseUrl: 'http://a/v1', model: 'm' });
    expect(config).toMatchObject({
      temperature: AGENT_DEFAULTS.temperature,
      maxTokens: AGENT_DEFAULTS.maxTokens,
      maxRetries: AGENT_DEFAULTS.maxRetries,
      toolDiscovery: AGENT_DEFAULTS.toolDiscovery,
    });
    expect(config.requestTimeoutSeconds).toBeUndefined();
    expect(config.apiKey).toBe(NO_KEY);
  });

  it('sends the default key only to the default endpoint', () => {
    expect(resolveAgent(DEFAULTS, {}).config.apiKey).toBe('default-key');
    expect(resolveAgent(DEFAULTS, { baseUrl: 'http://llm.local/v1/' }).config.apiKey).toBe('default-key');
    expect(resolveAgent(DEFAULTS, { baseUrl: 'http://elsewhere/v1' }).config.apiKey).toBe(NO_KEY);
    expect(resolveAgent(DEFAULTS, { baseUrl: 'http://elsewhere/v1', apiKey: 'own' }).config.apiKey).toBe('own');
  });

  it('never reaches for the environment’s key', () => {
    const before = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'instance-key';
    try {
      expect(resolveAgent(null, { baseUrl: 'http://a/v1', model: 'm' }).config.apiKey).toBe(NO_KEY);
    } finally {
      if (before === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = before;
    }
  });

  it('drops a value the spec will not take, and says so', () => {
    const { config, warnings } = resolveAgent(DEFAULTS, { temperature: 5 });
    expect(config.temperature).toBe(0.4);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^agent: .*temperature/);
  });
});

describe('remoteAgentConfig', () => {
  it('leaves a remote agent its own sampling and side work, and keeps the rest of the layers', () => {
    const tuned = { ...DEFAULTS, reasoningEffort: 'high', reasoningReplay: 'tool-loop', maxToolIterations: 7 };
    const { config: resolved } = resolveAgent(tuned, { model: 'triage', contextLength: 32768 });
    const config = remoteAgentConfig(resolved);
    expect(config).toMatchObject({
      remoteAgent: true,
      baseUrl: 'http://llm.local/v1',
      model: 'triage',
      apiKey: 'default-key',
      requestTimeoutSeconds: 120,
      maxRetries: 2,
      maxToolIterations: 7,
      toolDiscovery: 'eager',
      toolSelectModel: '',
    });
    for (const field of ['temperature', 'maxTokens', 'reasoningEffort', 'reasoningReplay']) {
      expect(config).not.toHaveProperty(field);
    }
    // The resolved agent is not written to: a local run of it is unchanged.
    expect(resolved).toMatchObject({ temperature: 0.4, maxTokens: 2048, toolDiscovery: 'ondemand' });
  });
});

describe('specLayer', () => {
  it('writes only what the row says', () => {
    expect(specLayer({ baseUrl: null, model: 'm', toolDiscovery: null })).toEqual({
      spec: AGENT_SPEC,
      model: { model: 'm' },
    });
  });
});

describe('unrunnable', () => {
  it('names what an agent resolves without', () => {
    expect(unrunnable({ baseUrl: '', model: '' }, 'Worker')).toMatch(/^Worker has no endpoint and no model/);
    expect(unrunnable({ baseUrl: 'http://a', model: '' }, 'Worker')).toMatch(/^Worker has no model/);
    expect(unrunnable({ baseUrl: 'http://a', model: 'm' }, 'Worker')).toBeNull();
  });
});

describe('keyFor', () => {
  it('chooses a key for one endpoint as a run would', () => {
    expect(keyFor('http://llm.local/v1', null, DEFAULTS)).toBe('default-key');
    expect(keyFor('http://elsewhere/v1', null, DEFAULTS)).toBeNull();
    expect(keyFor('http://elsewhere/v1', 'own', DEFAULTS)).toBe('own');
    expect(keyFor('http://elsewhere/v1', null, null)).toBeNull();
  });
});
