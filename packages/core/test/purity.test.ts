// SPDX-License-Identifier: Apache-2.0
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('core purity', () => {
  it('imports no fs, network or process APIs', () => {
    const dir = join(import.meta.dirname, '../src');
    for (const f of readdirSync(dir)) {
      const src = readFileSync(join(dir, f), 'utf8');
      expect(src, f).not.toMatch(/from 'node:(fs|net|http|https|http2|dgram|dns|child_process|tls)/);
      expect(src, f).not.toMatch(/\b(fetch|XMLHttpRequest|WebSocket)\(/);
      expect(src, f).not.toMatch(/process\.env/);
      expect(src, f).not.toMatch(/Date\.now\(\)|Math\.random\(\)/);
      for (const m of src.matchAll(/from '([^']+)'/g))
        expect(m[1]!.startsWith('.') || m[1] === 'node:crypto', `${f}: ${m[1]}`).toBe(true);
    }
  });
});
