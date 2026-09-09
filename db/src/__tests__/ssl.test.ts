import { describe, expect, it } from 'vitest';
import { requiresSsl } from '../ssl.ts';

// Getting this wrong does not fail loudly at review time — it fails at boot, on
// someone else's machine, as a TLS handshake reset against a database that was
// never listening for TLS.
describe('requiresSsl', () => {
  it('leaves the decision to the driver when sslmode is stated', () => {
    expect(requiresSsl('postgres://u:p@db.example.com/x?sslmode=require')).toBe(false);
    expect(requiresSsl('postgres://u:p@db.example.com/x?sslmode=disable')).toBe(false);
  });

  it('does not confuse credentials with the host', () => {
    // The bug this whole function exists for: `postgres:` before the `@` is a
    // username, and matching the raw string finds it where the host should be.
    expect(requiresSsl('postgres://telos:telos@postgres:5432/telos')).toBe(false);
    expect(requiresSsl('postgres://postgres:secret@db.example.com:5432/telos')).toBe(true);
  });

  it('treats loopback as local', () => {
    expect(requiresSsl('postgres://localhost:5432/x')).toBe(false);
    expect(requiresSsl('postgres://u:p@127.0.0.1:5432/x')).toBe(false);
    expect(requiresSsl('postgres://u:p@[::1]:5432/x')).toBe(false);
  });

  it('treats a dotless name as a container or LAN host', () => {
    expect(requiresSsl('postgres://u:p@postgres:5432/x')).toBe(false);
    expect(requiresSsl('postgres://u:p@db:5432/x')).toBe(false);
  });

  it('treats private address space as local', () => {
    expect(requiresSsl('postgres://u:p@10.0.0.175:5435/x')).toBe(false);
    expect(requiresSsl('postgres://u:p@192.168.1.20:5432/x')).toBe(false);
    expect(requiresSsl('postgres://u:p@172.16.0.5:5432/x')).toBe(false);
    expect(requiresSsl('postgres://u:p@172.31.255.254:5432/x')).toBe(false);
    expect(requiresSsl('postgres://u:p@[fd00::1]:5432/x')).toBe(false);
  });

  it('requires TLS for anything that could leave a private network', () => {
    expect(requiresSsl('postgres://u:p@db.example.com:5432/x')).toBe(true);
    expect(requiresSsl('postgresql://u:p@aws-0-eu-west-1.pooler.supabase.com/x')).toBe(true);
    expect(requiresSsl('postgres://u:p@8.8.8.8:5432/x')).toBe(true);
    // 172.32 is outside 172.16/12, and public.
    expect(requiresSsl('postgres://u:p@172.32.0.1:5432/x')).toBe(true);
    expect(requiresSsl('postgres://u:p@[2606:4700::1]:5432/x')).toBe(true);
  });

  it('does not force TLS on a string it cannot parse', () => {
    expect(requiresSsl('not a url')).toBe(false);
  });
});
