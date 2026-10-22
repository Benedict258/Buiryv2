// SPDX-License-Identifier: Apache-2.0

export const NAMESPACE_MAX_BYTES = 255;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PROJECT_RE = /^prj_[0-9A-Za-z]{8,40}$/;

export function isValidBranchSlug(slug: string): boolean {
  return slug.length >= 1 && slug.length <= 63 && SLUG_RE.test(slug);
}

/** Derives the Walrus namespace. Called server-side only; never accepts a client namespace. */
export function deriveNamespace(projectId: string, branchSlug: string): string {
  if (!PROJECT_RE.test(projectId)) throw new Error('invalid project id');
  if (!isValidBranchSlug(branchSlug)) throw new Error('invalid branch slug');
  const ns = `buiry.v1.${projectId}.${branchSlug}`;
  if (new TextEncoder().encode(ns).length > NAMESPACE_MAX_BYTES) throw new Error('namespace too long');
  return ns;
}

export function parseNamespace(ns: string): { projectId: string; branch: string } | null {
  const m = /^buiry\.v1\.(prj_[0-9A-Za-z]{8,40})\.([a-z0-9-]+)$/.exec(ns);
  if (!m || !m[1] || !m[2] || !isValidBranchSlug(m[2])) return null;
  return { projectId: m[1], branch: m[2] };
}
