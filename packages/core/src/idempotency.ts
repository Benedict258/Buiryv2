// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';

/** SHA-256 over namespace, header line and text (unit-separated to avoid ambiguity). */
export function idempotencyKey(namespace: string, header: string, text: string): string {
  return createHash('sha256')
    .update(namespace)
    .update('\u001f')
    .update(header)
    .update('\u001f')
    .update(text)
    .digest('hex');
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
