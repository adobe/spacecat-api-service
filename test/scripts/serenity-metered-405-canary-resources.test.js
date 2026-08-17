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
import { resolvePromptDims, isZeroHeadroom } from '../../scripts/serenity-metered-405-canary-resources.mjs';

describe('serenity-metered-405-canary resource helpers', () => {
  describe('resolvePromptDims', () => {
    it('resolves the legacy flat prompts shape', () => {
      const result = resolvePromptDims({ prompts: { used: 3, total: 10 } });
      expect(result).to.deep.equal({
        shape: 'legacy',
        dims: [{ key: 'prompts', used: 3, total: 10 }],
      });
    });

    it('resolves the tiered daily/weekly prompts shape', () => {
      const result = resolvePromptDims({
        daily_prompts: { used: 0, total: 0 },
        weekly_prompts: { used: 2, total: 5 },
      });
      expect(result).to.deep.equal({
        shape: 'tiered',
        dims: [
          { key: 'daily_prompts', used: 0, total: 0 },
          { key: 'weekly_prompts', used: 2, total: 5 },
        ],
      });
    });

    it('prefers the legacy shape when both a flat prompts field and tiered fields are present', () => {
      const result = resolvePromptDims({
        prompts: { used: 1, total: 1 },
        daily_prompts: { used: 0, total: 0 },
        weekly_prompts: { used: 0, total: 0 },
      });
      expect(result.shape).to.equal('legacy');
    });

    it('falls back to the tiered shape when prompts is present but malformed', () => {
      const result = resolvePromptDims({
        prompts: {},
        daily_prompts: { used: 0, total: 0 },
        weekly_prompts: { used: 0, total: 0 },
      });
      expect(result.shape).to.equal('tiered');
    });

    it('returns null when only one of the two tiered dimensions is present', () => {
      expect(resolvePromptDims({ daily_prompts: { used: 0, total: 0 } })).to.equal(null);
    });

    it('returns null when neither shape is present', () => {
      expect(resolvePromptDims({})).to.equal(null);
      expect(resolvePromptDims(undefined)).to.equal(null);
    });

    it('returns null when a dimension is missing used/total', () => {
      expect(resolvePromptDims({ prompts: { used: 3 } })).to.equal(null);
    });
  });

  describe('isZeroHeadroom', () => {
    it('is true when every dimension has total <= used', () => {
      expect(isZeroHeadroom([{ used: 0, total: 0 }, { used: 5, total: 3 }])).to.equal(true);
    });

    it('is false when any dimension still has headroom', () => {
      expect(isZeroHeadroom([{ used: 0, total: 0 }, { used: 1, total: 5 }])).to.equal(false);
    });

    it('is false (not vacuously true) for an empty dims array', () => {
      expect(isZeroHeadroom([])).to.equal(false);
    });
  });

  describe('resolvePromptDims field narrowing', () => {
    it('does not carry unrelated vendor fields through into dims', () => {
      const result = resolvePromptDims({ prompts: { used: 1, total: 2, extra_vendor_field: 'x' } });
      expect(result.dims[0]).to.deep.equal({ key: 'prompts', used: 1, total: 2 });
    });
  });
});
