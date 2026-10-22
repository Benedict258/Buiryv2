// SPDX-License-Identifier: Apache-2.0
import {
  BuiryError,
  ERROR_CODES,
  type BranchInput,
  type BranchOutput,
  type BuiryBackend,
  type ChainReadInput,
  type ChainReadOutput,
  type ChainSimulateInput,
  type ChainSimulateOutput,
  type CheckInput,
  type CheckOutput,
  type ConnectInput,
  type ConnectOutput,
  type ErrorCode,
  type HandoffInput,
  type HandoffOutput,
  type MemoryDetail,
  type RecallInput,
  type RecallOutput,
  type RememberBulkOutput,
  type RememberInput,
  type RememberOutput,
  type ReportInput,
  type ReportOutput,
  type ResolveInput,
  type ResolveOutput,
  type StatusOutput,
  type VerifyInput,
  type VerifyOutput,
} from '@buiry/core';

export interface RestBackendOptions {
  baseUrl: string;
  token: string;
  sessionId?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Talks to the Buiry API's agent surface (/v1/agent/*). The MCP server holds no state beyond this. */
export class RestBackend implements BuiryBackend {
  private readonly f: typeof fetch;
  private readonly base: string;

  constructor(private readonly o: RestBackendOptions) {
    this.f = o.fetch ?? fetch;
    this.base = o.baseUrl.replace(/\/+$/, '');
  }

  private async post<T>(op: string, body: unknown): Promise<T> {
    return this.call('POST', `/v1/agent/${op}`, body);
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.o.timeoutMs ?? 30_000);
    let res: Response;
    try {
      res = await this.f(this.base + path, {
        method,
        headers: {
          authorization: `Bearer ${this.o.token}`,
          'content-type': 'application/json',
          ...(this.o.sessionId ? { 'x-buiry-session': this.o.sessionId } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new BuiryError(
        'storage_unavailable',
        `Buiry service is unreachable (${(e as Error).message}); continue without project memory and retry later`,
        15_000,
      );
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let json: {
      ok?: boolean;
      data?: T;
      error?: { code?: string; message?: string; retryAfterMs?: number; details?: Record<string, unknown> };
    } = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new BuiryError(
        'storage_unavailable',
        `Buiry service returned an unexpected response (HTTP ${res.status})`,
        15_000,
      );
    }
    if (json.ok === true) return json.data as T;
    const code = (ERROR_CODES as readonly string[]).includes(json.error?.code ?? '')
      ? (json.error!.code as ErrorCode)
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

  connect(i: ConnectInput) {
    return this.post<ConnectOutput>('connect', i);
  }
  check(i: CheckInput) {
    return this.post<CheckOutput>('check', i);
  }
  remember(i: RememberInput) {
    return this.post<RememberOutput>('remember', i);
  }
  rememberBulk(items: RememberInput[]) {
    return this.post<RememberBulkOutput>('remember_bulk', { items });
  }
  recall(i: RecallInput) {
    return this.post<RecallOutput>('recall', i);
  }
  report(i: ReportInput) {
    return this.post<ReportOutput>('report', i);
  }
  resolve(i: ResolveInput) {
    return this.post<ResolveOutput>('resolve', i);
  }
  handoff(i: HandoffInput) {
    return this.post<HandoffOutput>('handoff', i);
  }
  verify(i: VerifyInput) {
    return this.post<VerifyOutput>('verify', i);
  }
  chainRead(i: ChainReadInput) {
    return this.post<ChainReadOutput>('chain_read', i);
  }
  chainSimulate(i: ChainSimulateInput) {
    return this.post<ChainSimulateOutput>('chain_simulate', i);
  }
  branch(i: BranchInput) {
    return this.post<BranchOutput>('branch', i);
  }
  status() {
    return this.post<StatusOutput>('status', {});
  }
  getMemory(memoryId: string) {
    return this.post<MemoryDetail>('memory', { memoryId });
  }
  getBriefing(branch?: string) {
    return this.post<CheckOutput>('briefing', { ...(branch ? { branch } : {}) });
  }
  getProject() {
    return this.post<ConnectOutput>('project', {});
  }
}
