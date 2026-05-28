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
  LANGUAGE_TAG_REGEX,
  normalizeLanguageCode,
  normalizeGeoTargetId,
} from '../../../src/support/serenity/validation.js';

/**
 * Dedicated unit tests for the serenity input normalizers (Minor #5 from the
 * multi-agent PR review). Coverage was transitive through markets.test.js and
 * prompts.test.js, which exercise callers, not the validator contract. This
 * file locks the normalizer behavior independently of caller behavior so a
 * regression in either normalizer surfaces here before the integration tests
 * have a chance to mask it.
 */
describe('serenity/validation — normalizeLanguageCode', () => {
  it('returns the input lowercased when it matches BCP-47 primary subtag', () => {
    expect(normalizeLanguageCode('en')).to.equal('en');
    expect(normalizeLanguageCode('de')).to.equal('de');
  });

  it('lowercases mixed-case input (POST /markets parity with the rest of the surface)', () => {
    expect(normalizeLanguageCode('EN')).to.equal('en');
    expect(normalizeLanguageCode('De')).to.equal('de');
    expect(normalizeLanguageCode('DE-CH')).to.equal('de-ch');
  });

  it('accepts a 2–4 letter region/script subtag', () => {
    expect(normalizeLanguageCode('de-ch')).to.equal('de-ch');
    expect(normalizeLanguageCode('zh-hans')).to.equal('zh-hans');
  });

  it('returns null for null and undefined', () => {
    expect(normalizeLanguageCode(null)).to.equal(null);
    expect(normalizeLanguageCode(undefined)).to.equal(null);
  });

  it('returns null for empty string and whitespace-only', () => {
    expect(normalizeLanguageCode('')).to.equal(null);
    expect(normalizeLanguageCode('   ')).to.equal(null);
  });

  it('returns null for non-string inputs that cannot reasonably language-tag', () => {
    expect(normalizeLanguageCode(42)).to.equal(null);
    expect(normalizeLanguageCode({})).to.equal(null);
    expect(normalizeLanguageCode([])).to.equal(null);
    expect(normalizeLanguageCode(true)).to.equal(null);
  });

  it('returns null for syntactically malformed tags', () => {
    expect(normalizeLanguageCode('e')).to.equal(null); // too short
    expect(normalizeLanguageCode('eng-x')).to.equal(null); // region subtag must be 2-4 letters
    expect(normalizeLanguageCode('1234')).to.equal(null); // digits
    expect(normalizeLanguageCode('en-')).to.equal(null); // trailing dash
    expect(normalizeLanguageCode('en-USA-XYZ')).to.equal(null); // too many subtags
  });

  it('LANGUAGE_TAG_REGEX itself accepts and rejects exactly what normalize accepts/rejects', () => {
    // Direct regex coverage so a regression that mutates the regex without
    // updating normalize (or vice versa) surfaces immediately.
    expect(LANGUAGE_TAG_REGEX.test('en')).to.equal(true);
    expect(LANGUAGE_TAG_REGEX.test('de-ch')).to.equal(true);
    expect(LANGUAGE_TAG_REGEX.test('EN')).to.equal(false); // case-sensitive on the raw regex
    expect(LANGUAGE_TAG_REGEX.test('eng-x')).to.equal(false);
  });
});

describe('serenity/validation — normalizeGeoTargetId', () => {
  it('returns the input when it is a positive integer', () => {
    expect(normalizeGeoTargetId(1)).to.equal(1);
    expect(normalizeGeoTargetId(2840)).to.equal(2840);
    expect(normalizeGeoTargetId(2276)).to.equal(2276);
  });

  it('returns null for zero (must be > 0)', () => {
    expect(normalizeGeoTargetId(0)).to.equal(null);
  });

  it('returns null for negative integers', () => {
    expect(normalizeGeoTargetId(-1)).to.equal(null);
    expect(normalizeGeoTargetId(-2840)).to.equal(null);
  });

  it('returns null for non-integer numbers (float, Infinity, NaN)', () => {
    expect(normalizeGeoTargetId(2840.5)).to.equal(null);
    expect(normalizeGeoTargetId(Number.POSITIVE_INFINITY)).to.equal(null);
    expect(normalizeGeoTargetId(Number.NEGATIVE_INFINITY)).to.equal(null);
    expect(normalizeGeoTargetId(Number.NaN)).to.equal(null);
  });

  it('returns null for string-of-digits (this normalizer expects already-parsed numbers)', () => {
    // The controller's parsedQuery is responsible for the string→int conversion
    // for query params; this normalizer is the second-line check.
    expect(normalizeGeoTargetId('2840')).to.equal(null);
  });

  it('returns null for null and undefined', () => {
    expect(normalizeGeoTargetId(null)).to.equal(null);
    expect(normalizeGeoTargetId(undefined)).to.equal(null);
  });

  it('returns null for non-numeric inputs', () => {
    expect(normalizeGeoTargetId({})).to.equal(null);
    expect(normalizeGeoTargetId([])).to.equal(null);
    expect(normalizeGeoTargetId(true)).to.equal(null);
  });
});
