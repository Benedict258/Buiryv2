// SPDX-License-Identifier: Apache-2.0
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BuiryError, ERROR_CODES, type ErrorCode } from '@buiry/core';

export interface Credentials {
  apiUrl: string;
  token: string;
}

/** Calls the Buiry REST API (/v1) and unwraps its {ok,data}/{ok,error} envelope into BuiryError. */
export class ApiClient {
  constructor(
    private readonly creds: Credentials,
    private readonly f: typeof fetch = fetch,
  ) {}

  async call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.f(this.creds.apiUrl.replace(/\/+$/, '') + path, {
        method,
        headers: {
          authorization: `Bearer ${this.creds.token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      throw new BuiryError(
        'storage_unavailable',
        `cannot reach ${this.creds.apiUrl}: ${(e as Error).message}`,
      );
    }
    const text = await res.text();
    let json: any = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new BuiryError(
        'storage_unavailable',
        `unexpected response from ${this.creds.apiUrl} (HTTP ${res.status})`,
      );
    }
    if (json.ok) return json.data as T;
    const code = (ERROR_CODES as readonly string[]).includes(json.error?.code)
      ? (json.error.code as ErrorCode)
      : res.status === 401
        ? 'unauthorized'
        : 'internal';
    throw new BuiryError(
      code,
      json.error?.message ?? `request failed (HTTP ${res.status})`,
      json.error?.retryAfterMs,
      json.error?.details,
    );
  }

  get = <T = any>(path: string) => this.call<T>('GET', path);
  post = <T = any>(path: string, body?: unknown) => this.call<T>('POST', path, body ?? {});
}

/** Anonymous calls (sign-in). */
export async function anonymous<T = any>(
  apiUrl: string,
  path: string,
  body: unknown,
  f: typeof fetch = fetch,
): Promise<T> {
  return new ApiClient({ apiUrl, token: '' }, f).call<T>('POST', path, body);
}
