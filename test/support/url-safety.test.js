/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { expect } from 'chai';

import { sanitizeUrlForReason } from '../../src/support/url-safety.js';

describe('sanitizeUrlForReason', () => {
  it('keeps scheme://host/path and drops the query and fragment', () => {
    const out = sanitizeUrlForReason('https://acme.okta.com/app/home?token=secret&x=1#frag');
    expect(out).to.equal('https://acme.okta.com/app/home');
  });

  it('preserves a normal login URL unchanged', () => {
    const out = sanitizeUrlForReason('https://example.com/sampoorna/login.html');
    expect(out).to.equal('https://example.com/sampoorna/login.html');
  });

  it('strips Slack mrkdwn formatting characters from the path', () => {
    const out = sanitizeUrlForReason('https://example.com/a*b_c~d|e');
    expect(out).to.equal('https://example.com/abcde');
  });

  it('neutralizes a Slack link-injection payload in the path', () => {
    const out = sanitizeUrlForReason('https://evil.com/x<https://internal.host|click-me>');
    // No characters that Slack mrkdwn (or an HTML sink) could use to break out remain.
    expect(out).to.not.match(/[<>|`*_~]/);
    expect(out.startsWith('https://evil.com/')).to.equal(true);
  });

  it('strips control characters (log/line-break injection)', () => {
    const out = sanitizeUrlForReason('https://example.com/a\r\nb\tc');
    expect(out).to.equal('https://example.com/abc');
  });

  it('caps the length at 256 characters', () => {
    const longPath = 'x'.repeat(1000);
    const out = sanitizeUrlForReason(`https://example.com/${longPath}`);
    expect(out.length).to.equal(256);
  });

  it('returns an empty string for an unparseable URL', () => {
    expect(sanitizeUrlForReason('not a url')).to.equal('');
    expect(sanitizeUrlForReason('')).to.equal('');
  });
});
