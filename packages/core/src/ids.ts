// SPDX-License-Identifier: Apache-2.0

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export type IdPrefix = 'prj' | 'mem' | 'hnd' | 'agt' | 'evt' | 'job' | 'flg' | 'brn' | 'ver' | 'wsp' | 'usr';

/** ULID-style id: 10 time chars + 16 random chars. Randomness is injected so core stays pure. */
export function newId(prefix: IdPrefix, nowMs: number, random: (n: number) => Uint8Array): string {
  let t = Math.floor(nowMs);
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = random(16);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[(bytes[i] ?? 0) % 32];
  return `${prefix}_${time}${rand}`;
}

const ID_RE = /^(prj|mem|hnd|agt|evt|job|flg|brn|ver|wsp|usr)_[0-9A-Za-z]{8,40}$/;
export function isId(value: string, prefix?: IdPrefix): boolean {
  return ID_RE.test(value) && (!prefix || value.startsWith(prefix + '_'));
}
