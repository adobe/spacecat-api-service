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

/* eslint-env mocha */

import { expect } from 'chai';
import {
  sanitizeMarkdown,
  scrubDeep,
  redactFeedbackContent,
  SECRET_PATTERNS,
} from '../../src/support/feedback-redaction.js';

describe('feedback-redaction', () => {
  describe('sanitizeMarkdown', () => {
    it('strips <script> blocks', () => {
      expect(sanitizeMarkdown('<script>alert(1)</script>keep')).to.equal('keep');
    });

    it('strips <style> and <iframe> blocks', () => {
      expect(sanitizeMarkdown('a<style>x{}</style>b<iframe src="x"></iframe>c')).to.equal('abc');
    });

    it('strips an unclosed script tag', () => {
      expect(sanitizeMarkdown('hi<script src="evil.js">')).to.equal('hi');
    });

    it('removes inline event-handler attributes', () => {
      expect(sanitizeMarkdown('<img src=x onerror="boom()">')).to.not.contain('onerror');
    });

    it('neutralises javascript: URIs', () => {
      // eslint-disable-next-line no-script-url -- testing the scheme is stripped
      expect(sanitizeMarkdown('[x](javascript:evil())')).to.not.contain('javascript:');
    });

    it('neutralises data:text/html URIs but leaves data:image alone', () => {
      expect(sanitizeMarkdown('data:text/html,<b>')).to.not.contain('data:text/html');
      expect(sanitizeMarkdown('data:image/png;base64,AAA')).to.contain('data:image/png');
    });

    it('strips <svg> blocks (svg-internal script vector)', () => {
      expect(sanitizeMarkdown('a<svg><script>alert(1)</script></svg>b')).to.equal('ab');
    });

    it('strips <noscript> and <template> smuggling blocks', () => {
      const out = sanitizeMarkdown('x<noscript><img src=y onerror=z></noscript><template>t</template>w');
      expect(out).to.equal('xw');
    });

    it('neutralises data:image/svg+xml but leaves data:image/png alone', () => {
      expect(sanitizeMarkdown('data:image/svg+xml,<svg onload=x>')).to.not.contain('data:image/svg');
      expect(sanitizeMarkdown('data:image/png;base64,AAA')).to.contain('data:image/png');
    });

    it('strips <object> and <embed> elements', () => {
      expect(sanitizeMarkdown('a<object data=x></object>b<embed src=y>c')).to.equal('abc');
    });

    it('passes non-string values through untouched', () => {
      expect(sanitizeMarkdown(undefined)).to.equal(undefined);
      expect(sanitizeMarkdown(42)).to.equal(42);
    });

    it('leaves ordinary markdown intact', () => {
      const md = '## Title\n\n- **bold** and `code`\n\n[link](https://example.com)';
      expect(sanitizeMarkdown(md)).to.equal(md);
    });
  });

  describe('scrubDeep', () => {
    it('redacts secrets in a nested structure and counts hits', () => {
      const hits = {};
      const out = scrubDeep({
        a: 'AKIAABCDEFGHIJKLMNOP',
        b: [`ghp_${'x'.repeat(25)}`, 5, true, null],
        c: { d: 'nothing here' },
      }, hits);
      expect(out.a).to.contain('[[REDACTED:aws_access_key]]');
      expect(out.b[0]).to.contain('[[REDACTED:github_pat]]');
      expect(out.b[1]).to.equal(5);
      expect(out.b[2]).to.equal(true);
      expect(out.b[3]).to.equal(null);
      expect(out.c.d).to.equal('nothing here');
      expect(hits.aws_access_key).to.equal(1);
      expect(hits.github_pat).to.equal(1);
    });

    it('passes primitive leaves through', () => {
      const hits = {};
      expect(scrubDeep(7, hits)).to.equal(7);
      expect(scrubDeep(null, hits)).to.equal(null);
      expect(scrubDeep(false, hits)).to.equal(false);
    });

    it('covers each declared secret pattern at least once', () => {
      const samples = {
        pem_private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
        aws_access_key: 'AKIAABCDEFGHIJKLMNOP',
        github_pat: `ghp_${'a'.repeat(25)}`,
        gitlab_pat: `glpat-${'a'.repeat(25)}`,
        slack_token: 'xoxb-1234567890-abcdefghij',
        llm_api_key: `sk-${'a'.repeat(20)}`,
        bearer_token: 'Bearer abcdefghijklmnop',
        jwt: 'eyJhbGciOi.eyJzdWIi.SflKxwRJ',
        basic_auth_url: 'https://user:pass@host.com',
        adobe_internal_host: 'foo.corp.adobe.com',
        adobe_email: 'someone@adobe.com',
      };
      for (const { label } of SECRET_PATTERNS) {
        const hits = {};
        const out = scrubDeep(samples[label], hits);
        expect(out, `pattern ${label}`).to.contain(`[[REDACTED:${label}]]`);
        expect(hits[label], `hit count ${label}`).to.be.greaterThan(0);
      }
    });
  });

  describe('redactFeedbackContent', () => {
    it('sanitises + scrubs markdown and scrubs both patches, aggregating hits', () => {
      const result = redactFeedbackContent({
        detailMarkdown: '<script>x</script> key AKIAABCDEFGHIJKLMNOP me@adobe.com',
        guidanceMarkdown: '<style>y</style> issue at foo.corp.adobe.com',
        previousFix: { code: 'Bearer abcdefghijklmnop' },
        editedFix: { code: `ghp_${'z'.repeat(25)}` },
      });
      expect(result.detailMarkdown).to.not.contain('<script>');
      expect(result.detailMarkdown).to.contain('[[REDACTED:aws_access_key]]');
      expect(result.detailMarkdown).to.contain('[[REDACTED:adobe_email]]');
      // guidance_markdown is sanitised + scrubbed the same way (defence in depth)
      expect(result.guidanceMarkdown).to.not.contain('<style>');
      expect(result.guidanceMarkdown).to.contain('[[REDACTED:adobe_internal_host]]');
      expect(result.previousFix.code).to.contain('[[REDACTED:bearer_token]]');
      expect(result.editedFix.code).to.contain('[[REDACTED:github_pat]]');
      expect(result.scrubHits.aws_access_key).to.be.greaterThan(0);
    });

    it('leaves clean content unchanged with no hits', () => {
      const result = redactFeedbackContent({
        detailMarkdown: 'plain rationale',
        previousFix: { a: 1 },
      });
      expect(result.detailMarkdown).to.equal('plain rationale');
      expect(result.previousFix).to.deep.equal({ a: 1 });
      expect(result.scrubHits).to.deep.equal({});
    });

    it('preserves undefined optional fields', () => {
      const result = redactFeedbackContent({ detailMarkdown: undefined });
      expect(result.detailMarkdown).to.equal(undefined);
      expect(result.previousFix).to.equal(undefined);
      expect(result.editedFix).to.equal(undefined);
    });

    it('defaults to empty input', () => {
      const result = redactFeedbackContent();
      expect(result.scrubHits).to.deep.equal({});
    });
  });
});
