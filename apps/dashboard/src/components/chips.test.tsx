import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { EvidenceChip, StatusChip } from './ui';

// Phase 9 D3: every status chip shows an icon and its label (colour is never the only signal), in the colour the
// palette brief assigns. Verified evidence is a lime chip with accent-ink text.

const chip = (status: Parameters<typeof StatusChip>[0]['status']) =>
  renderToStaticMarkup(<StatusChip status={status} />);

describe('status chips', () => {
  const cases: [Parameters<typeof StatusChip>[0]['status'], string, string][] = [
    ['proposed', 'var(--s-proposed)', ''],
    ['confirmed', 'var(--s-confirmed)', ''],
    ['contested', 'var(--s-contested)', ''],
    ['stale', 'var(--s-stale)', ''],
    ['superseded', 'var(--s-superseded)', 'lucide-replace'],
    ['tombstoned', 'var(--s-tombstoned)', 'lucide-strikethrough'],
    ['expired', 'var(--s-expired)', 'lucide-clock'],
  ];
  for (const [status, colour, icon] of cases)
    it(`${status}: icon, label and ${colour}`, () => {
      const html = chip(status);
      expect(html).toContain('<svg');
      expect(html).toMatch(new RegExp(`>${status}</span>$`));
      expect(html).toContain(`--c:${colour}`);
      if (icon) expect(html).toContain(icon);
    });

  it('confirmed says only a person confirms', () => {
    expect(chip('confirmed')).toContain('title="Confirmed by a person"');
  });
});

describe('evidence chip', () => {
  const e = { kind: 'tx' as const, digest: 'ABCDEFGH' } as unknown as Parameters<typeof EvidenceChip>[0]['e'];
  it('verified: lime chip with accent-ink text, icon and the word', () => {
    const html = renderToStaticMarkup(<EvidenceChip e={e} result="pass" />);
    expect(html).toContain('class="chip mono verified"');
    expect(html).toContain('evidence verified');
  });
  it('unknown and failed keep icon and word; no lime', () => {
    for (const [r, word] of [
      ['fail', 'failed'],
      [undefined, 'unknown'],
    ] as const) {
      const html = renderToStaticMarkup(<EvidenceChip e={e} result={r} />);
      expect(html).not.toContain('verified"');
      expect(html).toContain(`evidence ${word}`);
      expect(html).toContain('<svg');
    }
  });
});
