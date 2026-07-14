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
  buildMarketsPayload,
  transformMarketsToFilterDimensions,
} from '../../../../src/support/elements/definitions/markets.js';

describe('markets definitions', () => {
  describe('buildMarketsPayload', () => {
    it('returns minimal payload when no brand is provided', () => {
      const payload = buildMarketsPayload();
      expect(payload).to.deep.equal({ comparison_data_formatting: 'union' });
    });

    it('returns minimal payload when brand is an empty string', () => {
      const payload = buildMarketsPayload({ brand: '' });
      expect(payload).to.deep.equal({ comparison_data_formatting: 'union' });
    });

    it('includes brand filter when brand is provided', () => {
      const payload = buildMarketsPayload({ brand: 'Adobe' });
      expect(payload.filters.advanced.filters[0]).to.deep.include({
        op: 'eq',
        val: 'Adobe',
        col: 'CBF_ws_brand',
      });
    });

    it('sets comparison_data_formatting to union when brand is provided', () => {
      const payload = buildMarketsPayload({ brand: 'Adobe' });
      expect(payload.comparison_data_formatting).to.equal('union');
    });

    it('uses AND operator when brand filter is applied', () => {
      const payload = buildMarketsPayload({ brand: 'Adobe' });
      expect(payload.filters.advanced.op).to.equal('and');
    });

    it('includes simple filter object when brand is provided', () => {
      const payload = buildMarketsPayload({ brand: 'Adobe' });
      expect(payload.filters.simple).to.deep.equal({});
    });
  });

  describe('transformMarketsToFilterDimensions', () => {
    it('returns an empty array when raw is null', () => {
      expect(transformMarketsToFilterDimensions(null)).to.deep.equal([]);
    });

    it('returns an empty array when raw has no blocks', () => {
      expect(transformMarketsToFilterDimensions({})).to.deep.equal([]);
    });

    it('extracts geo code from label before first hyphen', () => {
      const raw = { blocks: { value: [{ value: 'proj-1', label: 'US-en' }] } };
      const [item] = transformMarketsToFilterDimensions(raw);
      expect(item.id).to.equal('US');
    });

    it('sets id to null when label has no hyphen', () => {
      const raw = { blocks: { value: [{ value: 'proj-1', label: 'Global' }] } };
      const [item] = transformMarketsToFilterDimensions(raw);
      expect(item.id).to.be.null;
    });

    it('stores semrush_project_id from item.value', () => {
      const raw = { blocks: { value: [{ value: 'proj-uuid-123', label: 'AU-en' }] } };
      const [item] = transformMarketsToFilterDimensions(raw);
      expect(item.semrush_project_id).to.equal('proj-uuid-123');
    });

    it('sets semrush_project_id to null when item.value is missing', () => {
      const raw = { blocks: { value: [{ label: 'AU-en' }] } };
      const [item] = transformMarketsToFilterDimensions(raw);
      expect(item.semrush_project_id).to.be.null;
    });

    it('enriches with SpaceCat metadata when matching BrandSemrushProject exists', () => {
      const raw = { blocks: { value: [{ value: 'proj-1', label: 'US-en' }] } };
      const brandSemrushProjects = [
        {
          semrushProjectId: 'proj-1',
          brandId: 'brand-abc',
          geoTargetId: 2840,
          languageCode: 'en',
        },
      ];
      const [item] = transformMarketsToFilterDimensions(raw, brandSemrushProjects);
      expect(item.spacecat_brand_id).to.equal('brand-abc');
      expect(item.geoTargetId).to.equal(2840);
      expect(item.languageCode).to.equal('en');
    });

    it('defaults SpaceCat fields to null when no matching project', () => {
      const raw = { blocks: { value: [{ value: 'proj-unknown', label: 'US-en' }] } };
      const brandSemrushProjects = [
        {
          semrushProjectId: 'proj-1', brandId: 'brand-abc', geoTargetId: 2840, languageCode: 'en',
        },
      ];
      const [item] = transformMarketsToFilterDimensions(raw, brandSemrushProjects);
      expect(item.spacecat_brand_id).to.be.null;
      expect(item.geoTargetId).to.be.null;
      expect(item.languageCode).to.be.null;
    });

    it('does not enrich an item with missing value from a null-keyed project row', () => {
      // A BrandSemrushProject row with a null semrushProjectId must not become a
      // Map key that a value-less market item then matches against.
      const raw = { blocks: { value: [{ label: 'US-en' }] } };
      const brandSemrushProjects = [
        {
          semrushProjectId: null, brandId: 'brand-xyz', geoTargetId: 2840, languageCode: 'en',
        },
      ];
      const [item] = transformMarketsToFilterDimensions(raw, brandSemrushProjects);
      expect(item.semrush_project_id).to.be.null;
      expect(item.spacecat_brand_id).to.be.null;
      expect(item.geoTargetId).to.be.null;
      expect(item.languageCode).to.be.null;
    });

    it('defaults brandSemrushProjects to empty array when not provided', () => {
      const raw = { blocks: { value: [{ value: 'proj-1', label: 'US-en' }] } };
      const result = transformMarketsToFilterDimensions(raw);
      expect(result[0].spacecat_brand_id).to.be.null;
    });

    it('stores the label from item', () => {
      const raw = { blocks: { value: [{ value: 'proj-1', label: 'AU-en' }] } };
      const [item] = transformMarketsToFilterDimensions(raw);
      expect(item.label).to.equal('AU-en');
    });

    it('handles multiple markets', () => {
      const raw = {
        blocks: {
          value: [
            { value: 'proj-1', label: 'US-en' },
            { value: 'proj-2', label: 'AU-en' },
          ],
        },
      };
      const result = transformMarketsToFilterDimensions(raw);
      expect(result).to.have.length(2);
      expect(result[0].id).to.equal('US');
      expect(result[1].id).to.equal('AU');
    });
  });
});
