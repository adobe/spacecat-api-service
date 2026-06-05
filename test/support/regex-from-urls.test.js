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

import {
  regexFromUrls,
  validateUserRegex,
  REGEX_FROM_URLS_INTERNALS,
} from '../../src/support/regex-from-urls.js';

function applyRegex(regex, path) {
  return new RegExp(regex.replace(/^\(\?i\)/, ''), 'i').test(path);
}

describe('regexFromUrls', () => {
  // ── input validation ──
  it('throws when urls is not an array', () => {
    expect(() => regexFromUrls(undefined)).to.throw(/non-empty array/);
    expect(() => regexFromUrls('not an array')).to.throw(/non-empty array/);
    expect(() => regexFromUrls(null)).to.throw(/non-empty array/);
  });

  it('throws on empty array', () => {
    expect(() => regexFromUrls([])).to.throw(/non-empty array/);
  });

  it('throws on non-string entries', () => {
    expect(() => regexFromUrls([123])).to.throw(/non-empty string/);
    expect(() => regexFromUrls([''])).to.throw(/non-empty string/);
  });

  it('throws on whitespace-only entries', () => {
    expect(() => regexFromUrls(['   '])).to.throw(/non-empty string/);
    expect(() => regexFromUrls(['/ok', '\t'])).to.throw(/non-empty string/);
  });

  // ── strategy 1: common prefix ──
  it('strategy 1: derives a common-prefix regex when URLs share a full path segment', () => {
    const result = regexFromUrls([
      'https://example.com/products/photoshop/install',
      'https://example.com/products/photoshop/buy',
      'https://example.com/products/photoshop/learn',
    ]);
    expect(result.method).to.equal('common-prefix');
    expect(result.regex).to.match(/^\(\?i\)\^/);
    expect(result.evidence).to.include('share prefix');
    expect(applyRegex(result.regex, '/products/photoshop/install')).to.be.true;
    expect(applyRegex(result.regex, '/products/photoshop/anything-else')).to.be.true;
  });

  // Fix 1: snap to segment boundary — mid-segment prefix must be trimmed.
  it('Fix 1: trims prefix when it stops mid-segment', () => {
    const result = regexFromUrls([
      '/products/payments',
      '/products/payroll',
      '/products/photoshop',
    ]);
    // Raw prefix would be "/products/p" — must snap back to "/products/"
    expect(result.method).to.equal('common-prefix');
    expect(result.regex).to.equal('(?i)^/?(?:[a-z]{2}(?:-[a-z]{2,4})?/)?products/');
    expect(applyRegex(result.regex, '/products/payments')).to.be.true;
    expect(applyRegex(result.regex, '/products/other')).to.be.true;
    expect(applyRegex(result.regex, '/jp/products/payments')).to.be.true; // localized traffic
  });

  it('Fix 1: keeps prefix when every input has end-or-slash after it', () => {
    const result = regexFromUrls([
      '/products/photoshop',
      '/products/photoshop/cc',
      '/products/photoshop/features',
    ]);
    // prefix is "/products/photoshop" — after it every input has '' or '/'.
    // A non-"/"-terminated prefix is bounded with (/|\.|$) so it cannot match a
    // longer sibling like "/products/photoshopx".
    expect(result.method).to.equal('common-prefix');
    expect(result.regex).to.equal('(?i)^/?(?:[a-z]{2}(?:-[a-z]{2,4})?/)?products/photoshop(/|\\.|$)');
    expect(applyRegex(result.regex, '/products/photoshop')).to.be.true;
    expect(applyRegex(result.regex, '/products/photoshop/cc')).to.be.true;
    expect(applyRegex(result.regex, '/products/photoshopx')).to.be.false;
  });

  it('strategy 1 → 2 fallback when only "/" is shared', () => {
    const result = regexFromUrls([
      'https://example.com/shared/a',
      'https://example.com/shared/b',
    ]);
    expect(['common-prefix', 'universal-token']).to.include(result.method);
    expect(applyRegex(result.regex, '/shared/a')).to.be.true;
    expect(applyRegex(result.regex, '/shared/b')).to.be.true;
  });

  // Fix 3: locale-root prefix rejection.
  it('Fix 3: rejects a locale-only prefix (/en-us/) and falls through', () => {
    // These paths span categories — the common prefix is /en-us/ which is locale-only.
    const result = regexFromUrls([
      '/en-us/products/foo',
      '/en-us/support/bar',
      '/en-us/blog/baz',
    ]);
    // Must NOT emit (?i)^/en-us/ — must fall through to a later strategy.
    expect(result.regex).to.not.equal('(?i)^/en-us/');
    expect(result.method).to.not.equal('common-prefix');
  });

  it('Fix 3: accepts a single non-locale segment prefix like /products/', () => {
    const result = regexFromUrls([
      '/products/foo',
      '/products/bar',
    ]);
    expect(result.method).to.equal('common-prefix');
    expect(result.regex).to.equal('(?i)^/?(?:[a-z]{2}(?:-[a-z]{2,4})?/)?products/');
  });

  it('Fix 3: accepts /ipos/ (single segment, not a locale)', () => {
    const result = regexFromUrls([
      '/ipos/intro',
      '/ipos/advanced',
    ]);
    expect(result.method).to.equal('common-prefix');
    expect(result.regex).to.equal('(?i)^/?(?:[a-z]{2}(?:-[a-z]{2,4})?/)?ipos/');
  });

  // Fix 5: case-insensitive prefix computation.
  it('Fix 5: computes prefix case-insensitively (mixed-case paths)', () => {
    const result = regexFromUrls([
      '/Industries/technology',
      '/industries/finance',
    ]);
    // Should still find /Industries/ or /industries/ as common prefix (case-folded compare).
    expect(result.method).to.equal('common-prefix');
    // The prefix from first input's casing should be used, snapped to boundary.
    expect(result.regex.toLowerCase()).to.include('industries/');
  });

  // ── strategy 2: universal token ──
  it('strategy 2: whole-segment token present in every URL', () => {
    const result = regexFromUrls([
      'https://example.com/buy/photoshop',
      'https://example.com/learn/photoshop',
      'https://example.com/try/photoshop/features',
    ]);
    expect(result.method).to.equal('universal-token');
    expect(result.regex).to.include('photoshop');
    expect(applyRegex(result.regex, '/buy/photoshop')).to.be.true;
    expect(applyRegex(result.regex, '/some/photoshop/install')).to.be.true;
  });

  // Fix 2: .html extension must NOT become a universal token.
  it('Fix 2: strips .html extension — does not produce (?i)(html)', () => {
    const result = regexFromUrls([
      '/campaigns/summer.html',
      '/campaigns/winter.html',
      '/campaigns/spring.html',
    ]);
    // "html" must not be the token; the common prefix /campaigns/ should win.
    expect(result.regex).to.not.include('html');
    // common prefix /campaigns/ should fire
    expect(result.method).to.equal('common-prefix');
  });

  // Fix 2: token must be a whole segment, not a substring.
  it('Fix 2: token is anchored at segment boundaries (not a bare substring match)', () => {
    const result = regexFromUrls([
      '/buy/photoshop',
      '/download/photoshop',
    ]);
    expect(result.method).to.equal('universal-token');
    // regex must anchor: /photoshop(/|.|$) — should NOT match /photoshop-extras
    expect(applyRegex(result.regex, '/buy/photoshop')).to.be.true;
    // substring "photoshop" inside "photoshop-extras" should NOT match if anchored
    // (the segment "photoshop-extras" != "photoshop")
    expect(applyRegex(result.regex, '/buy/notphotoshop')).to.be.false;
  });

  // ── strategy 3: disjoint cover ──
  it('strategy 3: anchored alternation when URLs share neither prefix nor token', () => {
    const result = regexFromUrls([
      '/photoshop-pro/install',
      '/illustrator-tools/setup',
      '/acrobat-reader/download',
    ]);
    expect(result.method).to.equal('disjoint-cover');
    expect(applyRegex(result.regex, '/photoshop-pro/install')).to.be.true;
    expect(applyRegex(result.regex, '/illustrator-tools/setup')).to.be.true;
    expect(applyRegex(result.regex, '/acrobat-reader/download')).to.be.true;
  });

  // Fix 4: disjoint-cover tokens anchored at segment boundaries.
  it('Fix 4: disjoint-cover does not match mid-word substring', () => {
    const result = regexFromUrls([
      '/contact/us',
      '/pricing/plans',
    ]);
    expect(result.method).to.equal('disjoint-cover');
    // "contact" token must NOT match "/contactform" (mid-word collision)
    expect(applyRegex(result.regex, '/contact/us')).to.be.true;
    expect(applyRegex(result.regex, '/contactform/submit')).to.be.false;
  });

  // A child URL already covered by a chosen parent token must not add a
  // redundant alternative: /travel-insurance covers /travel-insurance/uk-...
  it('collapses child URLs already covered by a parent token', () => {
    const urls = [
      '/health-insurance/',
      '/travel-insurance/',
      '/travel-insurance/uk-travel-insurance',
      '/travel-insurance/thailand-travel-insurance',
    ];
    const result = regexFromUrls(urls);
    expect(result.method).to.equal('disjoint-cover');
    expect(result.regex).to.equal('(?i)(?:^|/)(health-insurance|travel-insurance)(/|\\.|$)');
    urls.forEach((u) => expect(applyRegex(result.regex, u)).to.be.true);
  });

  it('prefers distinctive segments over generic containers (no /docs or /browse grab)', () => {
    // Mixed roots (/docs/<product>, /browse/<product>): the rule must capture the
    // product segments, not collapse to the shared containers "docs"/"browse".
    const result = regexFromUrls([
      '/docs/customer-journey-analytics-learn/tutorials/overview',
      '/docs/analytics-platform/using/cja-landing',
      '/browse/customer-journey-analytics',
    ]);
    expect(result.method).to.equal('disjoint-cover');
    expect(result.regex).to.not.match(/docs|browse/);
    expect(applyRegex(result.regex, '/docs/customer-journey-analytics-learn/x')).to.be.true;
    expect(applyRegex(result.regex, '/browse/customer-journey-analytics')).to.be.true;
  });

  it('prefers a deeper universal token over a generic container common-prefix', () => {
    // Both share only /solutions/ as a prefix, but "value-based-care" is in both.
    const result = regexFromUrls([
      '/solutions/athenaone/value-based-care',
      '/solutions/value-based-care/population-health-management',
    ]);
    expect(result.method).to.equal('universal-token');
    expect(result.regex).to.equal('(?i)(?:^|/)value-based-care(/|\\.|$)');
    expect(applyRegex(result.regex, '/solutions/athenaone/value-based-care')).to.be.true;
    // does NOT over-match the whole /solutions/ container
    expect(applyRegex(result.regex, '/solutions/electronic-health-records')).to.be.false;
  });

  // ── locale stripping → locale-agnostic rules ──
  it('strips a leading locale and emits a locale-agnostic rule', () => {
    const result = regexFromUrls([
      '/en-gb/basketball/basketballs/fiba-3x3',
      '/en-gb/basketball/basketballs/evolution',
      '/en-gb/basketball/nba-shop',
    ]);
    expect(result.regex).to.equal('(?i)^/?(?:[a-z]{2}(?:-[a-z]{2,4})?/)?basketball/');
    // matches the sample locale AND others — not locked to /en-gb.
    expect(applyRegex(result.regex, '/en-gb/basketball/nba-shop')).to.be.true;
    expect(applyRegex(result.regex, '/de/basketball/x')).to.be.true;
    expect(applyRegex(result.regex, '/basketball/x')).to.be.true;
  });

  it('derives a locale-agnostic rule from locale-prefixed samples', () => {
    const result = regexFromUrls([
      '/en-gb/golf/clubs/woods-hybrids',
      '/en-gb/golf/complete-golf-club-sets',
    ]);
    expect(result.regex).to.equal('(?i)^/?(?:[a-z]{2}(?:-[a-z]{2,4})?/)?golf/');
    expect(applyRegex(result.regex, '/fr/golf/anything')).to.be.true;
    expect(applyRegex(result.regex, '/golf/clubs')).to.be.true;
  });

  it('anchored rule from non-localized samples still matches localized traffic', () => {
    // Customer pastes bare /acrobat paths; live traffic is localized (/jp/acrobat).
    const result = regexFromUrls([
      '/acrobat',
      '/acrobat/pdf-reader',
      '/acrobat/online/pdf-editor',
    ]);
    expect(result.method).to.equal('common-prefix');
    expect(applyRegex(result.regex, '/acrobat')).to.be.true;
    expect(applyRegex(result.regex, '/jp/acrobat')).to.be.true;
    expect(applyRegex(result.regex, '/en-gb/acrobat/pdf-reader')).to.be.true;
    // a non-locale leading segment must NOT be treated as a locale
    expect(applyRegex(result.regex, '/products/acrobat')).to.be.false;
  });

  it('rejects a locale-only common prefix (double-locale path /us/en/…)', () => {
    // After stripping the leading /us, the remaining paths share /en/ — a
    // locale-only common prefix that must be rejected, not anchored as ^/en/.
    const result = regexFromUrls([
      '/us/en/alpha-page',
      '/us/en/beta-page',
    ]);
    expect(result.regex).to.not.match(/\^\/en\//);
    expect(applyRegex(result.regex, '/us/en/alpha-page')).to.be.true;
  });

  it('strips a trailing server-page extension before deriving (.mi/.aspx)', () => {
    // The .mi must not break the boundary snap: result is /loyalty/redeem, not /loyalty/.
    const result = regexFromUrls(['/loyalty/redeem.mi', '/loyalty/redeem/hotels.mi']);
    expect(result.method).to.equal('common-prefix');
    expect(result.regex).to.equal('(?i)^/?(?:[a-z]{2}(?:-[a-z]{2,4})?/)?loyalty/redeem(/|\\.|$)');
    // still matches the real .mi URLs at runtime via the (/|\.|$) boundary
    expect(applyRegex(result.regex, '/loyalty/redeem.mi')).to.be.true;
    expect(applyRegex(result.regex, '/loyalty/redeem/hotels.mi')).to.be.true;
  });

  it('only strips a TRAILING extension, never a dotted middle segment', () => {
    const result = regexFromUrls(['/aaa/node.js/docs', '/bbb/node.js/guide']);
    expect(result.method).to.equal('universal-token');
    expect(applyRegex(result.regex, '/x/node.js/y')).to.be.true;
    expect(applyRegex(result.regex, '/x/node/y')).to.be.false;
  });

  // 3-char segments must tokenize (not drop to literal fallback).
  it('tokenizes short 3-char segments like "mac"', () => {
    const result = regexFromUrls([
      'https://www.apple.com/mac/',
      'https://www.apple.com/ipad/',
      'https://www.apple.com/shop/accessories/all',
    ]);
    expect(result.method).to.equal('disjoint-cover');
    expect(result.regex).to.equal('(?i)(?:^|/)(mac|ipad|accessories)(/|\\.|$)');
    expect(applyRegex(result.regex, '/mac/macbook-air')).to.be.true;
    expect(applyRegex(result.regex, '/ipad/ipad-pro')).to.be.true;
  });

  // ── strategy 4: literal fallback ──
  it('strategy 4: literal fallback when no token is reusable', () => {
    const result = regexFromUrls(['/a/b', '/c/d']);
    expect(result.method).to.equal('literal-fallback');
    expect(applyRegex(result.regex, '/a/b')).to.be.true;
    expect(applyRegex(result.regex, '/c/d')).to.be.true;
  });

  // ── over-match tightening ──
  it('anchors literal fallback at both ends (no substring / prefix match)', () => {
    const result = regexFromUrls(['/a/b/c', '/d/e/f']);
    expect(result.method).to.equal('literal-fallback');
    expect(applyRegex(result.regex, '/a/b/c')).to.be.true;
    expect(applyRegex(result.regex, '/a/b/c/')).to.be.true; // segment boundary ok
    expect(applyRegex(result.regex, '/prefix/a/b/c')).to.be.false; // start-anchored
    expect(applyRegex(result.regex, '/a/b/cX')).to.be.false; // end-bounded
  });

  it('bounds a single-URL prefix so it does not match longer siblings', () => {
    const result = regexFromUrls(['/products/foo']);
    expect(result.method).to.equal('common-prefix');
    expect(applyRegex(result.regex, '/products/foo')).to.be.true;
    expect(applyRegex(result.regex, '/products/foo/bar')).to.be.true;
    expect(applyRegex(result.regex, '/products/foobar')).to.be.false;
    expect(applyRegex(result.regex, '/products/food')).to.be.false;
  });

  it('does not emit a locale-only token via the token strategies', () => {
    // common-prefix /en-us/ is locale-rejected; the token strategies must not
    // resurrect "en-us" as a universal/disjoint token (whole-locale rule).
    const result = regexFromUrls(['/en-us/products/x', '/en-us/blog/y']);
    expect(result.regex).to.not.match(/\(en-us\)|\/en-us\(/);
    expect(applyRegex(result.regex, '/en-us/random/page')).to.be.false;
  });

  it('keeps a dotted middle segment instead of truncating it', () => {
    // "node.js" is a middle segment — the extension strip must not chop it to
    // "node" (which would over-match "/node/", "/node.exe").
    const result = regexFromUrls(['/aaa/node.js/docs', '/bbb/node.js/guide']);
    expect(result.method).to.equal('universal-token');
    expect(applyRegex(result.regex, '/x/node.js/y')).to.be.true;
    expect(applyRegex(result.regex, '/x/node/y')).to.be.false;
  });

  // ── edge cases ──
  it('handles a single URL (common-prefix)', () => {
    const result = regexFromUrls(['https://example.com/blog/2026/article']);
    expect(result.method).to.equal('common-prefix');
    expect(applyRegex(result.regex, '/blog/2026/article')).to.be.true;
  });

  it('handles all-identical URLs', () => {
    const result = regexFromUrls([
      'https://example.com/products/foo',
      'https://example.com/products/foo',
    ]);
    expect(result.method).to.equal('common-prefix');
    expect(applyRegex(result.regex, '/products/foo')).to.be.true;
  });

  it('accepts bare paths (no protocol)', () => {
    const result = regexFromUrls(['/blog/intro', '/blog/advanced']);
    expect(result.method).to.equal('common-prefix');
    expect(applyRegex(result.regex, '/blog/intro')).to.be.true;
  });

  it('falls back when URL parsing fails (raw input used as path)', () => {
    const result = regexFromUrls(['photoshop-page', 'photoshop-other']);
    expect(applyRegex(result.regex, 'photoshop-page')).to.be.true;
  });

  it('escapes regex metacharacters in literal fallback', () => {
    // 2-char segments stay below MIN_TOKEN_LEN, so no token forms and the
    // ladder reaches the literal fallback — where escaping must still apply.
    const result = regexFromUrls(['/a$', '/c+']);
    expect(result.method).to.equal('literal-fallback');
    expect(applyRegex(result.regex, '/a$')).to.be.true;
    expect(applyRegex(result.regex, '/c+')).to.be.true;
  });

  it('handles very long URLs without truncation when under the cap', () => {
    const long = `/p/${'x'.repeat(100)}`;
    const result = regexFromUrls([long, `/p/${'y'.repeat(100)}`]);
    expect(applyRegex(result.regex, long)).to.be.true;
  });

  it('falls through to literal fallback when inputs share no common prefix', () => {
    // segments are too short (<3) to tokenize and share no prefix → literal fallback.
    const result = regexFromUrls(['ab', 'cd']);
    expect(result.method).to.equal('literal-fallback');
    expect(applyRegex(result.regex, 'ab')).to.be.true;
    expect(applyRegex(result.regex, 'cd')).to.be.true;
  });

  it('throws when every strategy exceeds the regex length cap', () => {
    // A 600-char shared segment blows past MAX_REGEX_LEN (512) for common-prefix,
    // universal-token, disjoint-cover, and the literal fallback alike — so the
    // ladder exhausts and regexFromUrls throws.
    const seg = 'a'.repeat(600);
    expect(() => regexFromUrls([`/${seg}/x`, `/${seg}/y`]))
      .to.throw(/Failed to derive a regex/);
  });

  it('exposes internals for downstream test/tools', () => {
    expect(REGEX_FROM_URLS_INTERNALS.MIN_TOKEN_LEN).to.equal(3);
    expect(REGEX_FROM_URLS_INTERNALS.MAX_REGEX_LEN).to.equal(512);
  });
});

describe('validateUserRegex', () => {
  it('normalizes a case-sensitive paste to case-insensitive (prepends (?i))', () => {
    // Without (?i) the stored regex would run case-sensitive in Athena/JONI
    // while validation (forced 'i') claimed it matched case-insensitively.
    expect(validateUserRegex('^/products/')).to.equal('(?i)^/products/');
    expect(validateUserRegex('/EN/')).to.equal('(?i)/EN/');
  });

  it('leaves an already case-insensitive paste unchanged', () => {
    expect(validateUserRegex('(?i)(foo|bar)')).to.equal('(?i)(foo|bar)');
  });

  it('throws on non-string or empty', () => {
    expect(() => validateUserRegex(undefined)).to.throw(/non-empty string/);
    expect(() => validateUserRegex('')).to.throw(/non-empty string/);
    expect(() => validateUserRegex(42)).to.throw(/non-empty string/);
  });

  it('throws when over the length cap', () => {
    const big = 'a'.repeat(513);
    expect(() => validateUserRegex(big)).to.throw(/exceeds/);
  });

  it('throws on uncompilable regex', () => {
    expect(() => validateUserRegex('([unclosed')).to.throw(/not a valid/);
  });
});
