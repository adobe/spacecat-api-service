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
import { SUGGESTION_TYPES_REQUIRING_FIX_ENTITY } from '../../src/utils/suggestion-fix-required-types.js';

describe('SUGGESTION_TYPES_REQUIRING_FIX_ENTITY', () => {
  it('is a non-empty array of unique strings', () => {
    expect(SUGGESTION_TYPES_REQUIRING_FIX_ENTITY).to.be.an('array').that.is.not.empty;
    expect(new Set(SUGGESTION_TYPES_REQUIRING_FIX_ENTITY).size)
      .to.equal(SUGGESTION_TYPES_REQUIRING_FIX_ENTITY.length);
    SUGGESTION_TYPES_REQUIRING_FIX_ENTITY.forEach((type) => {
      expect(type).to.be.a('string').that.is.not.empty;
    });
  });

  it('includes the reported opportunity types (alt-text, broken-backlinks)', () => {
    expect(SUGGESTION_TYPES_REQUIRING_FIX_ENTITY).to.include('alt-text');
    expect(SUGGESTION_TYPES_REQUIRING_FIX_ENTITY).to.include('broken-backlinks');
  });

  it('excludes generic-opportunity (shared fallback type used by unrelated flows)', () => {
    expect(SUGGESTION_TYPES_REQUIRING_FIX_ENTITY).to.not.include('generic-opportunity');
  });
});
