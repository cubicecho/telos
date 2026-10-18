import { describe, expect, it } from 'vitest';
import { McpSecretKind } from '@/__generated__/graphql';
import { readMcpJson, STDIO_REFUSED } from '@/lib/mcp-json';

const paste = (servers: object) => JSON.stringify({ mcpServers: servers });
const open = { taken: [], allowStdio: true };

describe('readMcpJson', () => {
  it('reads an http server, with its headers as secrets and not as values', () => {
    const { servers, error } = readMcpJson(
      paste({ docs: { type: 'http', url: 'https://docs.example/mcp', headers: { Authorization: 'Bearer abc' } } }),
      open,
    );

    expect(error).toBeNull();
    expect(servers).toEqual([
      {
        key: 'docs',
        stdio: false,
        values: {
          slug: 'docs',
          name: 'docs',
          enabled: true,
          url: 'https://docs.example/mcp',
          command: null,
          args: [],
          cwd: null,
          connectTimeoutMs: null,
          callTimeoutMs: null,
          idleTimeoutMs: null,
          hiddenTools: [],
          hooks: [],
        },
        secrets: [{ kind: McpSecretKind.Header, name: 'Authorization', value: 'Bearer abc' }],
        errors: [],
        warnings: [],
      },
    ]);
    expect(JSON.stringify(servers[0].values)).not.toContain('Bearer abc');
  });

  it('reads a stdio server, with its env as secrets', () => {
    const { servers } = readMcpJson(
      paste({
        files: { command: 'npx', args: ['-y', 'files-mcp'], cwd: '/srv', env: { TOKEN: 't0k' }, disabled: true },
      }),
      open,
    );

    expect(servers[0]).toMatchObject({
      key: 'files',
      stdio: true,
      values: { slug: 'files', command: 'npx', args: ['-y', 'files-mcp'], cwd: '/srv', url: null, enabled: false },
      secrets: [{ kind: McpSecretKind.Env, name: 'TOKEN', value: 't0k' }],
      errors: [],
    });
    expect(JSON.stringify(servers[0].values)).not.toContain('t0k');
  });

  it('refuses a stdio server until commands are allowed', () => {
    const text = paste({ files: { command: 'npx' }, docs: { url: 'https://docs.example/mcp' } });

    const closed = readMcpJson(text, { taken: [], allowStdio: false }).servers;
    expect(closed.map((server) => server.errors)).toEqual([[STDIO_REFUSED], []]);
    expect(readMcpJson(text, open).servers[0].errors).toEqual([]);
  });

  it('says what is wrong with an invalid entry, and with an unreadable paste', () => {
    const { servers } = readMcpJson(paste({ 'bad name': { command: '' }, web: { url: 'ftp://x' } }), open);

    expect(servers[0].errors).toEqual(['Letters, digits, - and _ only.', 'needs a command']);
    expect(servers[1].errors).toEqual(['"ftp://x" is not an http or https url']);
    expect(readMcpJson('{ nope', open)).toEqual({ servers: [], error: 'that config is not valid JSON' });
    expect(readMcpJson(paste({ old: { type: 'sse', url: 'http://x' } }), open).error).toMatch(/SSE/);
    expect(readMcpJson('  ', open)).toEqual({ servers: [], error: null });
  });

  it('holds each key to the account’s slug rule', () => {
    const { servers } = readMcpJson(
      paste({ docs: { url: 'https://a.example' }, telos: { url: 'https://b.example' } }),
      { taken: ['docs'], allowStdio: false },
    );

    expect(servers[0].errors).toEqual(['Another of your servers has that slug.']);
    expect(servers[1].errors).toEqual([expect.stringMatching(/telos’s own/)]);
  });

  it('leaves out a secret that is still a placeholder, and says so', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the .mcp.json placeholder itself, not a template
    const token = 'Bearer ${TOKEN}';
    const { servers } = readMcpJson(
      paste({ docs: { url: 'https://a.example', headers: { Authorization: token, 'X-Team': 'core' } } }),
      open,
    );

    expect(servers[0].secrets).toEqual([{ kind: McpSecretKind.Header, name: 'X-Team', value: 'core' }]);
    expect(servers[0].warnings).toEqual([`Authorization is still ${token}: set it under Secrets once it is added.`]);
  });
});
