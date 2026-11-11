import { describe, expect, it } from 'vitest';
import { elicitationQuestion, looksSecret } from '../elicit.ts';

// What a run asks a person when one of its servers asks mid-call: the server
// named, what it said, what it wanted, and where the reply goes.

describe("a server's question", () => {
  const params = {
    message: 'Which environment should this release go to?',
    requestedSchema: {
      type: 'object' as const,
      properties: {
        environment: { type: 'string' as const, title: 'Environment', enum: ['staging', 'production'] },
        notify: { type: 'boolean' as const, description: 'Tell the channel.' },
      },
      required: ['environment'],
    },
  };

  it('names the server and the call, and says what it asked', () => {
    const question = elicitationQuestion('Deploys', 'deploys__release', params);
    expect(question).toContain('The MCP server "Deploys" asked for input during `deploys__release`');
    expect(question).toContain('Deploys asks: Which environment should this release go to?');
  });

  it('lists the fields it wanted, with what each takes', () => {
    const question = elicitationQuestion('Deploys', 'deploys__release', params);
    expect(question).toContain('- Environment (`environment`), one of: staging, production, required');
    expect(question).toContain('- `notify`, yes or no: Tell the channel.');
  });

  it('tells the next run where the reply is, and that the server will ask again', () => {
    const question = elicitationQuestion('Deploys', 'deploys__release', params);
    expect(question).toContain('Reply in this thread.');
    expect(question).toContain('Deploys asks again when `deploys__release` is called the same way');
    expect(question).toContain('pass the reply to the tool in its arguments');
  });

  it('flags a field that looks like a secret, and only that one', () => {
    const question = elicitationQuestion('Deploys', 'deploys__release', {
      message: 'Sign in.',
      requestedSchema: {
        type: 'object' as const,
        properties: { user: { type: 'string' as const }, api_key: { type: 'string' as const } },
      },
    });
    const [user, key] = question.split('\n').filter((line) => line.startsWith('- '));
    expect(user).not.toContain('secret');
    expect(key).toContain('this looks like a secret');
    expect(key).toContain('do not reply with it here');
  });

  it('stands on its own when the server sends no fields and no message', () => {
    const question = elicitationQuestion('Deploys', 'deploys__release', {
      message: '  ',
      requestedSchema: { type: 'object' as const, properties: {} },
    });
    expect(question).toContain('Deploys asks: (no message)');
    expect(question).not.toContain('It wants:');
  });
});

describe('a secret-like field', () => {
  it('is known by its name, its title or its description', () => {
    expect(looksSecret('password', {})).toBe(true);
    expect(looksSecret('value', { title: 'Access token' })).toBe(true);
    expect(looksSecret('value', { description: 'Your API key for the service.' })).toBe(true);
    expect(looksSecret('pin', {})).toBe(true);
  });

  it('is not every field that happens to contain the letters', () => {
    expect(looksSecret('environment', { title: 'Environment' })).toBe(false);
    expect(looksSecret('spinner', {})).toBe(false);
    expect(looksSecret('author', { description: 'Who wrote it.' })).toBe(false);
  });
});
