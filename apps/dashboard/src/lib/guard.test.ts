import { describe, expect, it } from 'vitest';
import { isNotShared, signedOutRedirect } from './guard';

describe('signedOutRedirect', () => {
  it('hands the emailed link token to the sign-in page as its own parameter', () => {
    expect(signedOutRedirect('/auth/email', '?token=abc-123_X')).toBe('/signin?token=abc-123_X');
  });

  it('sends other signed-out visits to sign-in and remembers where they were going', () => {
    expect(signedOutRedirect('/w/wsp_1/projects', '?tab=a')).toBe(
      '/signin?next=' + encodeURIComponent('/w/wsp_1/projects?tab=a'),
    );
  });

  it('leaves the sign-in page and the public showcase alone', () => {
    expect(signedOutRedirect('/signin', '?token=x')).toBeNull();
    expect(signedOutRedirect('/showcase/prj_1', '')).toBeNull();
  });
});

describe('isNotShared', () => {
  it('treats a 404 without data as "not shared", not as a failure to retry', () => {
    expect(isNotShared({ status: 404 }, false)).toBe(true);
  });

  it('keeps real failures (and any loaded data) on the normal path', () => {
    expect(isNotShared({ status: 500 }, false)).toBe(false);
    expect(isNotShared({ status: 0 }, false)).toBe(false);
    expect(isNotShared({ status: 404 }, true)).toBe(false);
    expect(isNotShared(undefined, false)).toBe(false);
  });
});
