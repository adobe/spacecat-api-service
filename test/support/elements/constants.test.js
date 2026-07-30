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
import { normalizeChannel } from '../../../src/support/elements/constants.js';

describe('normalizeChannel', () => {
  it('returns an empty string for null', () => {
    expect(normalizeChannel(null)).to.equal('');
  });

  it('returns an empty string for undefined', () => {
    expect(normalizeChannel(undefined)).to.equal('');
  });

  it('returns an empty string for an empty string', () => {
    expect(normalizeChannel('')).to.equal('');
  });

  it('returns an empty string for a whitespace-only string', () => {
    expect(normalizeChannel('   ')).to.equal('');
  });

  it('lowercases and preserves a snake_case value as spaces', () => {
    expect(normalizeChannel('benchmark_competitors')).to.equal('benchmark competitors');
  });

  it('normalizes a Title Case, space-separated value to the same canonical form', () => {
    expect(normalizeChannel('Benchmark Competitors')).to.equal('benchmark competitors');
  });

  it('normalizes a hyphenated value the same way as snake_case', () => {
    expect(normalizeChannel('ai-generated')).to.equal('ai generated');
  });

  it('collapses repeated separators and trims surrounding whitespace', () => {
    expect(normalizeChannel('  Benchmark__Competitors  ')).to.equal('benchmark competitors');
  });

  it('leaves a single-word value unaffected apart from casing', () => {
    expect(normalizeChannel('Owned')).to.equal('owned');
  });

  it('collapses repeated internal whitespace to match the snake_case form', () => {
    expect(normalizeChannel('Benchmark  Competitors')).to.equal('benchmark competitors');
  });
});
