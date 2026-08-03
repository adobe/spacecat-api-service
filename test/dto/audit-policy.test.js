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
import { AuditPolicyDto, AuditPolicyRevisionDto } from '../../src/dto/audit-policy.js';

const SITE_ID = '7b2e3f9c-0000-4000-8000-000000000001';

describe('AuditPolicyDto', () => {
  it('toJSON maps snake_case row to camelCase', () => {
    const row = {
      site_id: SITE_ID,
      version: 5,
      budget: 4000,
      strategy_name: 'tiered',
      exclusion_globs: ['/checkout/*'],
      manual_urls: ['https://x/a'],
      scope_config: {},
      lifecycle_overrides: {},
      created_by: 'a',
      updated_by: 'b',
      reason: 'r',
      note: 'n',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
    };
    const dto = AuditPolicyDto.toJSON(row);
    expect(dto).to.deep.equal({
      siteId: SITE_ID,
      version: 5,
      budget: 4000,
      strategyName: 'tiered',
      exclusionGlobs: ['/checkout/*'],
      manualUrls: ['https://x/a'],
      scopeConfig: {},
      lifecycleOverrides: {},
      createdBy: 'a',
      updatedBy: 'b',
      reason: 'r',
      note: 'n',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
    expect(dto).to.not.have.any.keys('site_id', 'strategy_name', 'exclusion_globs');
  });

  it('toJSON normalizes raw Postgres timestamptz text to Z-suffixed ISO8601', () => {
    const row = {
      site_id: SITE_ID,
      version: 5,
      budget: 4000,
      strategy_name: 'tiered',
      exclusion_globs: [],
      manual_urls: [],
      scope_config: {},
      lifecycle_overrides: {},
      created_by: 'a',
      updated_by: 'b',
      reason: 'r',
      note: null,
      created_at: '2026-01-01T00:00:00.123456+00:00',
      updated_at: '2026-01-02T00:00:00.654321+00:00',
    };
    const dto = AuditPolicyDto.toJSON(row);
    expect(dto.createdAt).to.equal('2026-01-01T00:00:00.123Z');
    expect(dto.updatedAt).to.equal('2026-01-02T00:00:00.654Z');
  });

  it('toJSON throws on an unparseable timestamp instead of passing it through (fail loud on a corrupted row, not a silent passthrough)', () => {
    const row = {
      site_id: SITE_ID,
      version: 5,
      budget: 4000,
      strategy_name: 'tiered',
      exclusion_globs: [],
      manual_urls: [],
      scope_config: {},
      lifecycle_overrides: {},
      created_by: 'a',
      updated_by: 'b',
      reason: 'r',
      note: null,
      created_at: 'not-a-date',
      updated_at: '2026-01-02T00:00:00Z',
    };
    expect(() => AuditPolicyDto.toJSON(row)).to.throw(RangeError);
  });

  it('defaultDocument returns version 0 baseline when no row exists', () => {
    const dto = AuditPolicyDto.defaultDocument(SITE_ID);
    expect(dto).to.include({
      siteId: SITE_ID, version: 0, budget: 5000, strategyName: 'tiered',
    });
    expect(dto.exclusionGlobs).to.deep.equal([]);
    expect(dto.manualUrls).to.deep.equal([]);
    expect(dto.scopeConfig).to.deep.equal({});
    expect(dto.createdBy).to.equal(null);
  });

  it('revision toJSON exposes effectiveAt/supersededAt and per-version provenance', () => {
    const row = {
      version: 4,
      budget: 4000,
      strategy_name: 'tiered',
      exclusion_globs: [],
      manual_urls: [],
      scope_config: {},
      lifecycle_overrides: {},
      updated_by: 'b',
      reason: 'r',
      note: 'n',
      effective_at: '2026-01-01T00:00:00Z',
      superseded_at: '2026-01-02T00:00:00Z',
    };
    const dto = AuditPolicyRevisionDto.toJSON(row);
    expect(dto).to.include({
      version: 4,
      updatedBy: 'b',
      effectiveAt: '2026-01-01T00:00:00.000Z',
      supersededAt: '2026-01-02T00:00:00.000Z',
    });
  });

  it('revision toJSON uses resolvedUpdatedBy over the raw column when supplied', () => {
    const row = {
      version: 4,
      budget: 4000,
      strategy_name: 'tiered',
      exclusion_globs: [],
      manual_urls: [],
      scope_config: {},
      lifecycle_overrides: {},
      updated_by: 'A1B2C3D4E5F6@AdobeOrg',
      reason: 'r',
      note: null,
      effective_at: null,
      superseded_at: null,
    };
    const dto = AuditPolicyRevisionDto.toJSON(row, 'Jane Doe');
    expect(dto.updatedBy).to.equal('Jane Doe');
  });

  it('revision toJSON ignores a non-string 2nd arg (e.g. the array index from list.map) and keeps the raw column', () => {
    const row = {
      version: 4,
      budget: 4000,
      strategy_name: 'tiered',
      exclusion_globs: [],
      manual_urls: [],
      scope_config: {},
      lifecycle_overrides: {},
      updated_by: 'u@x.com',
      reason: 'r',
      note: null,
      effective_at: null,
      superseded_at: null,
    };
    // Simulates [row].map(AuditPolicyRevisionDto.toJSON) passing (row, index).
    const dto = AuditPolicyRevisionDto.toJSON(row, 3);
    expect(dto.updatedBy).to.equal('u@x.com');
  });

  it('revision toJSON falls back to the raw updated_by column when no resolution is supplied', () => {
    const row = {
      version: 4,
      budget: 4000,
      strategy_name: 'tiered',
      exclusion_globs: [],
      manual_urls: [],
      scope_config: {},
      lifecycle_overrides: {},
      updated_by: 'u@x.com',
      reason: 'r',
      note: null,
      effective_at: null,
      superseded_at: null,
    };
    const dto = AuditPolicyRevisionDto.toJSON(row);
    expect(dto.updatedBy).to.equal('u@x.com');
  });

  it('revision toJSON normalizes raw Postgres timestamptz text to Z-suffixed ISO8601', () => {
    const row = {
      version: 4,
      budget: 4000,
      strategy_name: 'tiered',
      exclusion_globs: [],
      manual_urls: [],
      scope_config: {},
      lifecycle_overrides: {},
      updated_by: 'b',
      reason: 'r',
      note: null,
      effective_at: '2026-01-01T00:00:00.123456+00:00',
      superseded_at: null,
    };
    const dto = AuditPolicyRevisionDto.toJSON(row);
    expect(dto.effectiveAt).to.equal('2026-01-01T00:00:00.123Z');
    expect(dto.supersededAt).to.equal(null);
  });
});
