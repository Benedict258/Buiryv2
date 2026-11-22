import { readFileSync } from 'node:fs';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppProvider } from '../lib/app';
import { MemoryRules } from './Settings';
import { PermChips, AGENT_PERMS } from './Agents';
import { TokenExpiry, TokenScopePicker, tokenCreateBody } from './WorkspacePages';

// Phase 9 D4: controls say what the code does. Agents raise confidence up to the cap and only a person confirms
// (M8, Phase 6 to 8); API tokens expire after 90 days by default and confirm only with an explicit scope (7.4).

const html = (n: ReactNode) => renderToStaticMarkup(<AppProvider>{n}</AppProvider>);
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('Settings: the helpful-report rule', () => {
  const out = text(
    html(<MemoryRules p={{ id: 'prj_1', settings: {} } as never} admin={true} reload={() => undefined} />),
  );
  it('no longer claims agents auto-promote memories', () => {
    expect(out).not.toMatch(/auto-promote/i);
  });
  it('says what it does: marks a memory ready for a person to confirm; agents raise confidence up to 0.7', () => {
    expect(out).toContain(
      'Mark a memory ready for a person to confirm when agents repeatedly report it helpful',
    );
    expect(out).toContain('Agents raise confidence up to 0.7. Only a person confirms.');
  });
});

describe('Agents: the confirm permission', () => {
  it('is presented as contest, never as confirming', () => {
    const label = AGENT_PERMS.find(([p]) => p === 'confirm')![1];
    expect(label).toMatch(/^Contest:/);
    expect(label).not.toMatch(/confirm other agents/i);
    expect(label).toContain('only a person confirms');
  });
  it('table chips show contest for the stored confirm permission', () => {
    const out = text(html(<PermChips perms={['read', 'write', 'confirm']} />));
    expect(out).toContain('contest');
    expect(out).not.toMatch(/\bconfirm\b/);
  });
  it('the agent drawer has no leftover wording', () => {
    const src = readFileSync(new URL('./Agents.tsx', import.meta.url), 'utf8');
    expect(src).not.toContain("confirm other agents' memories");
    expect(src).not.toContain('Permissions: {agent.permissions.join');
  });
});

describe('API tokens: confirm scope and expiry', () => {
  it('offers an explicit "can confirm" scope, off by default, without a warning until chosen', () => {
    const out = html(<TokenScopePicker scopes={['read']} onChange={() => undefined} />);
    expect(text(out)).toContain('Can confirm memories');
    expect(out).toMatch(/<input type="checkbox"[^>]*\/>\s*Can confirm memories/);
    expect(out).not.toMatch(/checked=""[^>]*\/>\s*Can confirm memories/);
    expect(text(out)).not.toContain('confirms memories as you');
  });
  it('warns once the confirm scope is chosen', () => {
    const out = text(html(<TokenScopePicker scopes={['read', 'confirm']} onChange={() => undefined} />));
    expect(out).toContain(
      'A token with this scope confirms memories as you. Never give it to an agent tool.',
    );
  });
  it('sends an expiry on create, 90 days by default', () => {
    expect(tokenCreateBody({ name: ' ci ', scopes: ['read'], projectIds: [] })).toEqual({
      name: 'ci',
      scopes: ['read'],
      expiresInDays: 90,
    });
    expect(tokenCreateBody({ name: 'x', scopes: ['read'], projectIds: ['prj_1'], days: 30 })).toEqual({
      name: 'x',
      scopes: ['read'],
      projectIds: ['prj_1'],
      expiresInDays: 30,
    });
  });
  it('shows the expiry, or that an older token has none', () => {
    expect(text(html(<TokenExpiry at={null} />))).toContain('No expiry');
    expect(text(html(<TokenExpiry at="2027-02-20T00:00:00.000Z" />))).toContain('2027');
  });
});
