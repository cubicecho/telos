import { describe, expect, it } from 'vitest';
import { McpSecretKind } from '@/__generated__/graphql';
import { isAddable, readMcpJson, STDIO_UNSUPPORTED } from '@/lib/mcp-json';

const paste = (servers: object) => JSON.stringify({ mcpServers: servers });
const open = { taken: [] };

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
        target: 'https://docs.example/mcp',
        values: {
          slug: 'docs',
          name: 'docs',
          enabled: true,
          url: 'https://docs.example/mcp',
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
    expect(isAddable(servers[0])).toBe(true);
    expect(JSON.stringify(servers[0].values)).not.toContain('Bearer abc');
  });

  it('lists a stdio server as not supported, with nothing to create and no secrets kept', () => {
    const { servers } = readMcpJson(
      paste({
        files: { command: 'npx', args: ['-y', 'files-mcp'], cwd: '/srv', env: { TOKEN: 't0k' } },
        docs: { url: 'https://docs.example/mcp' },
      }),
      open,
    );

    expect(servers[0]).toEqual({
      key: 'files',
      stdio: true,
      target: 'npx -y files-mcp',
      values: null,
      secrets: [],
      errors: [STDIO_UNSUPPORTED],
      warnings: [],
    });
    expect(STDIO_UNSUPPORTED).toMatch(/Not supported/);
    expect(JSON.stringify(servers[0])).not.toContain('t0k');
    expect(servers.map(isAddable)).toEqual([false, true]);
  });

  it('says what is wrong with an invalid entry, and with an unreadable paste', () => {
    const { servers } = readMcpJson(paste({ 'bad name': { url: 'https://x.example' }, web: { url: 'ftp://x' } }), open);

    expect(servers[0].errors).toEqual(['Letters, digits, - and _ only.']);
    expect(servers[1].errors).toEqual(['"ftp://x" is not an http or https url']);
    expect(readMcpJson('{ nope', open)).toEqual({ servers: [], error: 'that config is not valid JSON' });
    expect(readMcpJson(paste({ old: { type: 'sse', url: 'http://x' } }), open).error).toMatch(/SSE/);
    expect(readMcpJson('  ', open)).toEqual({ servers: [], error: null });
  });

  it('holds each key to the account’s slug rule', () => {
    const { servers } = readMcpJson(
      paste({ docs: { url: 'https://a.example' }, telos: { url: 'https://b.example' } }),
      { taken: ['docs'] },
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
