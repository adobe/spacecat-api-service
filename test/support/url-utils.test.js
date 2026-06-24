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
import { hostnameFromUrlString } from '../../src/support/url-utils.js';

describe('url-utils: hostnameFromUrlString', () => {
  it('extracts the hostname from a full URL', () => {
    expect(hostnameFromUrlString('https://acme.com/path?q=1')).to.equal('acme.com');
  });

  it('tolerates a bare hostname (no scheme)', () => {
    expect(hostnameFromUrlString('acme.com')).to.equal('acme.com');
  });

  it('returns null for empty/whitespace/non-string input', () => {
    expect(hostnameFromUrlString('')).to.equal(null);
    expect(hostnameFromUrlString('   ')).to.equal(null);
    expect(hostnameFromUrlString(undefined)).to.equal(null);
    expect(hostnameFromUrlString(null)).to.equal(null);
  });

  it('returns null for an unparseable URL (new URL throws)', () => {
    expect(hostnameFromUrlString('https://[')).to.equal(null);
  });
});
