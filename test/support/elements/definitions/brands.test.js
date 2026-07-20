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
  buildBrandsPayload,
  transformBrandsToFilterDimensions,
} from '../../../../src/support/elements/definitions/brands.js';
import { DEFAULT_ELEMENT_MODEL } from '../../../../src/support/elements/constants.js';

describe('brands definitions', () => {
  describe('buildBrandsPayload', () => {
    it('uses the default model when no params are provided', () => {
      const payload = buildBrandsPayload();
      expect(payload.filters.advanced.filters[0].val).to.equal(DEFAULT_ELEMENT_MODEL);
    });

    it('uses the default model when model is not in ELEMENT_MODELS', () => {
      const payload = buildBrandsPayload({ model: 'unknown-model' });
      expect(payload.filters.advanced.filters[0].val).to.equal(DEFAULT_ELEMENT_MODEL);
    });

    it('uses the provided model when it is in ELEMENT_MODELS', () => {
      const payload = buildBrandsPayload({ model: 'perplexity' });
      expect(payload.filters.advanced.filters[0].val).to.equal('perplexity');
    });

    it('translates a SpaceCat/UI platform code to the Semrush model', () => {
      const payload = buildBrandsPayload({ model: 'copilot' });
      expect(payload.filters.advanced.filters[0].val).to.equal('microsoft-copilot');
    });

    it('accepts the platform alias and translates it', () => {
      const payload = buildBrandsPayload({ platform: 'openai' });
      expect(payload.filters.advanced.filters[0].val).to.equal('gpt-5');
    });

    it('sets comparison_data_formatting to union', () => {
      const payload = buildBrandsPayload();
      expect(payload.comparison_data_formatting).to.equal('union');
    });

    it('uses AND operator in the advanced filter', () => {
      const payload = buildBrandsPayload();
      expect(payload.filters.advanced.op).to.equal('and');
    });

    it('filters on CBF_model column', () => {
      const payload = buildBrandsPayload();
      expect(payload.filters.advanced.filters[0].col).to.equal('CBF_model');
    });

    it('uses eq operator in the filter', () => {
      const payload = buildBrandsPayload();
      expect(payload.filters.advanced.filters[0].op).to.equal('eq');
    });
  });

  describe('transformBrandsToFilterDimensions', () => {
    it('returns an empty array when raw is null', () => {
      expect(transformBrandsToFilterDimensions(null)).to.deep.equal([]);
    });

    it('returns an empty array when raw has no blocks', () => {
      expect(transformBrandsToFilterDimensions({})).to.deep.equal([]);
    });

    it('sets id to the brand label', () => {
      const raw = { blocks: { value: [{ value: 'Adobe' }] } };
      const [item] = transformBrandsToFilterDimensions(raw);
      expect(item.id).to.equal('Adobe');
    });

    it('uses item.value as label', () => {
      const raw = { blocks: { value: [{ value: 'Adobe' }] } };
      const [item] = transformBrandsToFilterDimensions(raw);
      expect(item.label).to.equal('Adobe');
    });

    it('resolves spacecat_brand_id by case-insensitive name match', () => {
      const raw = { blocks: { value: [{ value: 'Adobe' }] } };
      const spacecatBrands = [{ id: 'brand-123', name: 'adobe' }];
      const [item] = transformBrandsToFilterDimensions(raw, spacecatBrands);
      expect(item.spacecat_brand_id).to.equal('brand-123');
    });

    it('matches case-insensitively when casing differs', () => {
      const raw = { blocks: { value: [{ value: 'ADOBE' }] } };
      const spacecatBrands = [{ id: 'brand-123', name: 'Adobe' }];
      const [item] = transformBrandsToFilterDimensions(raw, spacecatBrands);
      expect(item.spacecat_brand_id).to.equal('brand-123');
    });

    it('sets spacecat_brand_id to null when no matching SpaceCat brand', () => {
      const raw = { blocks: { value: [{ value: 'Nike' }] } };
      const spacecatBrands = [{ id: 'brand-123', name: 'Adobe' }];
      const [item] = transformBrandsToFilterDimensions(raw, spacecatBrands);
      expect(item.spacecat_brand_id).to.be.null;
    });

    it('sets spacecat_brand_id to null when spacecatBrands is empty', () => {
      const raw = { blocks: { value: [{ value: 'Adobe' }] } };
      const [item] = transformBrandsToFilterDimensions(raw, []);
      expect(item.spacecat_brand_id).to.be.null;
    });

    it('defaults spacecatBrands to empty array when not provided', () => {
      const raw = { blocks: { value: [{ value: 'Adobe' }] } };
      const result = transformBrandsToFilterDimensions(raw);
      expect(result[0].spacecat_brand_id).to.be.null;
    });

    it('handles multiple brands', () => {
      const raw = {
        blocks: {
          value: [
            { value: 'Adobe' },
            { value: 'Nike' },
          ],
        },
      };
      const spacecatBrands = [
        { id: 'brand-1', name: 'Adobe' },
        { id: 'brand-2', name: 'Nike' },
      ];
      const result = transformBrandsToFilterDimensions(raw, spacecatBrands);
      expect(result).to.have.length(2);
      expect(result[0].spacecat_brand_id).to.equal('brand-1');
      expect(result[1].spacecat_brand_id).to.equal('brand-2');
    });
  });
});
