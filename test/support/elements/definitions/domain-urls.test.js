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
import { buildDomainUrlsPayload } from '../../../../src/support/elements/definitions/domain-urls.js';
import { DEFAULT_ELEMENT_MODEL } from '../../../../src/support/elements/constants.js';

function modelFilter(payload) {
  return payload.filters.advanced.filters.find((filter) => filter.filters?.[0]?.col === 'CBF_model');
}

describe('domain-urls definitions', () => {
  describe('buildDomainUrlsPayload', () => {
    it('defaults the model to DEFAULT_ELEMENT_MODEL when no platform is provided', () => {
      const payload = buildDomainUrlsPayload();

      expect(modelFilter(payload)).to.deep.equal({
        op: 'or', filters: [{ op: 'eq', val: DEFAULT_ELEMENT_MODEL, col: 'CBF_model' }],
      });
    });

    it('omits the CBF_model filter for platform=all', () => {
      const payload = buildDomainUrlsPayload({ platform: 'all' });

      expect(modelFilter(payload)).to.be.undefined;
    });

    it('keeps the existing platform translation for non-all values', () => {
      const payload = buildDomainUrlsPayload({ platform: 'openai' });

      expect(modelFilter(payload).filters[0].val).to.equal('chatgpt-paid');
    });
  });
});
