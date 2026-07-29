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
  transformStatsSimpleNumericResponse,
  buildStatsTotalExecutionsPayload,
  transformStatsTotalExecutionsResponse,
  buildStatsMentionsPayload,
  transformStatsMentionsResponse,
  buildStatsVisibilityPayload,
  transformStatsVisibilityResponse,
  buildStatsCitationsPayload,
  transformStatsCitationsResponse,
} from '../../../../src/support/elements/definitions/brand-presence-stats.js';

const SIMPLE_NUMERIC_RESPONSE = {
  type: 'simpleNumeric',
  blocks: {
    firstSectionMainValue: [{ firstSectionMainValue: 14635 }],
    firstSectionSecondaryValue: [
      { firstSectionSecondaryValue: 1263, period: 'current' },
      { firstSectionSecondaryValue: 1263, period: 'previous' },
    ],
  },
};

describe('brand-presence-stats definitions', () => {
  describe('transformStatsSimpleNumericResponse', () => {
    it('extracts firstSectionMainValue', () => {
      expect(transformStatsSimpleNumericResponse(SIMPLE_NUMERIC_RESPONSE)).to.equal(14635);
    });

    it('returns 0 when the value is missing', () => {
      expect(transformStatsSimpleNumericResponse({})).to.equal(0);
      expect(transformStatsSimpleNumericResponse(null)).to.equal(0);
      expect(transformStatsSimpleNumericResponse(undefined)).to.equal(0);
    });

    it('returns 0 when the value is not a number', () => {
      const raw = { blocks: { firstSectionMainValue: [{ firstSectionMainValue: 'oops' }] } };
      expect(transformStatsSimpleNumericResponse(raw)).to.equal(0);
    });
  });

  describe('buildStatsTotalExecutionsPayload', () => {
    it('wraps CBF_ws_brand and CBF_model each in their own or block', () => {
      const payload = buildStatsTotalExecutionsPayload({
        model: 'search-gpt', startDate: '2026-07-01', endDate: '2026-07-14', brandName: 'Lovesac',
      });
      expect(payload.filters.simple).to.deep.equal({
        start_date: '2026-07-01',
        end_date: '2026-07-14',
      });
      expect(payload.filters.advanced).to.deep.equal({
        op: 'and',
        filters: [
          { op: 'or', filters: [{ op: 'eq', val: 'Lovesac', col: 'CBF_ws_brand' }] },
          { op: 'or', filters: [{ op: 'eq', val: 'search-gpt', col: 'CBF_model' }] },
        ],
      });
    });

    it('omits the project filter when projectIds is empty (aggregate view)', () => {
      const payload = buildStatsTotalExecutionsPayload({
        model: 'search-gpt', startDate: '2026-07-01', endDate: '2026-07-14', brandName: 'Lovesac', projectIds: [],
      });
      expect(payload.filters.advanced.filters).to.have.lengthOf(2);
    });

    it('ORs multiple project ids under CBF_project (singular)', () => {
      const payload = buildStatsTotalExecutionsPayload({
        model: 'search-gpt',
        startDate: '2026-07-01',
        endDate: '2026-07-14',
        brandName: 'Lovesac',
        projectIds: ['proj-1', 'proj-2'],
      });
      const projectFilter = payload.filters.advanced.filters.find(
        (f) => f.filters.some((sub) => sub.col === 'CBF_project'),
      );
      expect(projectFilter).to.deep.equal({
        op: 'or',
        filters: [
          { op: 'eq', val: 'proj-1', col: 'CBF_project' },
          { op: 'eq', val: 'proj-2', col: 'CBF_project' },
        ],
      });
    });

    it('never includes comparison_start_date/comparison_end_date', () => {
      const payload = buildStatsTotalExecutionsPayload({
        model: 'search-gpt', startDate: '2026-07-01', endDate: '2026-07-14', brandName: 'Lovesac',
      });
      expect(payload.filters.simple).to.not.have.property('comparison_start_date');
      expect(payload.filters.simple).to.not.have.property('comparison_end_date');
      expect(payload).to.not.have.property('comparison_data_formatting');
    });

    it('resolves an unknown model to the default model', () => {
      const payload = buildStatsTotalExecutionsPayload({
        model: 'not-a-real-model', startDate: '2026-07-01', endDate: '2026-07-14', brandName: 'Lovesac',
      });
      expect(payload.filters.advanced.filters[1].filters[0].val).to.equal('search-gpt');
    });
  });

  describe('transformStatsTotalExecutionsResponse', () => {
    it('extracts firstSectionMainValue', () => {
      expect(transformStatsTotalExecutionsResponse(SIMPLE_NUMERIC_RESPONSE)).to.equal(14635);
    });
  });

  describe('buildStatsMentionsPayload', () => {
    it('always includes CBF_ws_brand and CBF_model', () => {
      const payload = buildStatsMentionsPayload({
        model: 'search-gpt', startDate: '2026-07-01', endDate: '2026-07-14', brandName: 'Lovesac',
      });
      expect(payload.filters.advanced.filters).to.deep.include({
        op: 'eq', val: 'Lovesac', col: 'CBF_ws_brand',
      });
      expect(payload.filters.advanced.filters).to.deep.include({
        op: 'eq', val: 'search-gpt', col: 'CBF_model',
      });
    });

    it('omits the project filter when projectIds is empty', () => {
      const payload = buildStatsMentionsPayload({
        model: 'search-gpt', startDate: '2026-07-01', endDate: '2026-07-14', brandName: 'Lovesac', projectIds: [],
      });
      expect(payload.filters.advanced.filters).to.have.lengthOf(2);
    });

    it('ORs multiple project ids under CBF_project (singular)', () => {
      const payload = buildStatsMentionsPayload({
        model: 'search-gpt',
        startDate: '2026-07-01',
        endDate: '2026-07-14',
        brandName: 'Lovesac',
        projectIds: ['proj-1', 'proj-2'],
      });
      const projectFilter = payload.filters.advanced.filters.find((f) => f.op === 'or');
      expect(projectFilter).to.deep.equal({
        op: 'or',
        filters: [
          { op: 'eq', val: 'proj-1', col: 'CBF_project' },
          { op: 'eq', val: 'proj-2', col: 'CBF_project' },
        ],
      });
    });
  });

  describe('transformStatsMentionsResponse', () => {
    it('extracts firstSectionMainValue', () => {
      expect(transformStatsMentionsResponse(SIMPLE_NUMERIC_RESPONSE)).to.equal(14635);
    });
  });

  describe('buildStatsVisibilityPayload', () => {
    it('always includes CBF_ws_brand, with CBF_model wrapped in its own or block', () => {
      const payload = buildStatsVisibilityPayload({
        model: 'search-gpt', startDate: '2026-07-01', endDate: '2026-07-14', brandName: 'Lovesac',
      });
      expect(payload.filters.advanced.filters).to.deep.include({
        op: 'eq', val: 'Lovesac', col: 'CBF_ws_brand',
      });
      expect(payload.filters.advanced.filters).to.deep.include({
        op: 'or', filters: [{ op: 'eq', val: 'search-gpt', col: 'CBF_model' }],
      });
    });

    it('ORs multiple project ids under CBF_project (singular)', () => {
      const payload = buildStatsVisibilityPayload({
        model: 'search-gpt',
        startDate: '2026-07-01',
        endDate: '2026-07-14',
        brandName: 'Lovesac',
        projectIds: ['proj-1', 'proj-2'],
      });
      const projectFilter = payload.filters.advanced.filters.find(
        (f) => f.op === 'or' && f.filters.some((sub) => sub.col === 'CBF_project'),
      );
      expect(projectFilter.filters).to.deep.equal([
        { op: 'eq', val: 'proj-1', col: 'CBF_project' },
        { op: 'eq', val: 'proj-2', col: 'CBF_project' },
      ]);
    });
  });

  describe('transformStatsVisibilityResponse', () => {
    it('converts the 0-1 fraction to a 0-100 percentage', () => {
      const raw = {
        blocks: { firstSectionMainValue: [{ firstSectionMainValue: 0.4877215460175 }] },
      };
      expect(transformStatsVisibilityResponse(raw)).to.be.closeTo(48.77215460175, 1e-9);
    });

    it('returns 0 when the value is missing', () => {
      expect(transformStatsVisibilityResponse({})).to.equal(0);
    });
  });

  describe('buildStatsCitationsPayload', () => {
    it('uses CBF_brand (not CBF_ws_brand)', () => {
      const payload = buildStatsCitationsPayload({
        model: 'search-gpt', startDate: '2026-07-01', endDate: '2026-07-14', brandName: 'Lovesac',
      });
      expect(payload.filters.advanced.filters).to.deep.include({
        op: 'eq', val: 'Lovesac', col: 'CBF_brand',
      });
      expect(payload.filters.advanced.filters.some((f) => f.col === 'CBF_ws_brand')).to.equal(false);
    });

    it('ORs multiple project ids under CBF_projects (plural)', () => {
      const payload = buildStatsCitationsPayload({
        model: 'search-gpt',
        startDate: '2026-07-01',
        endDate: '2026-07-14',
        brandName: 'Lovesac',
        projectIds: ['proj-1', 'proj-2'],
      });
      const projectFilter = payload.filters.advanced.filters.find((f) => f.op === 'or');
      expect(projectFilter).to.deep.equal({
        op: 'or',
        filters: [
          { op: 'eq', val: 'proj-1', col: 'CBF_projects' },
          { op: 'eq', val: 'proj-2', col: 'CBF_projects' },
        ],
      });
    });
  });

  describe('transformStatsCitationsResponse', () => {
    it('extracts firstSectionMainValue', () => {
      expect(transformStatsCitationsResponse(SIMPLE_NUMERIC_RESPONSE)).to.equal(14635);
    });
  });
});
