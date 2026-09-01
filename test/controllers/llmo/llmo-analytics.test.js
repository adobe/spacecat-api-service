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
import sinon from 'sinon';
import esmock from 'esmock';
import { validateAnalysisRequest } from '../../../src/controllers/llmo/llmo-analytics.js';

describe('validateAnalysisRequest', () => {
  const validTime = { grain: 'week', dateFrom: '2026-01-01', dateTo: '2026-01-31' };

  it('accepts a minimal valid request', () => {
    const { value, error } = validateAnalysisRequest({
      metric: 'visibilityScore', dimensions: ['platform'], time: validTime,
    });
    expect(error).to.be.undefined;
    expect(value.metricId).to.equal('visibilityScore');
    expect(value.limit).to.equal(100);
  });

  it('rejects an unknown metric', () => {
    const { error } = validateAnalysisRequest({ metric: 'nope', time: validTime });
    expect(error).to.match(/Unsupported metric/);
  });

  it('rejects a dimension unsupported by the metric', () => {
    // citations does not support "competitor"
    const { error } = validateAnalysisRequest({
      metric: 'citations', dimensions: ['competitor'], time: validTime,
    });
    expect(error).to.match(/Unsupported metric\/dimension combination/);
  });

  it('rejects a missing time block', () => {
    const { error } = validateAnalysisRequest({ metric: 'visibilityScore' });
    expect(error).to.match(/time is required/);
  });

  it('rejects an unsupported grain', () => {
    const { error } = validateAnalysisRequest({
      metric: 'visibilityScore', time: { ...validTime, grain: 'day' },
    });
    expect(error).to.match(/Unsupported grain/);
  });

  it('rejects a non-ISO date', () => {
    const { error } = validateAnalysisRequest({
      metric: 'visibilityScore', time: { ...validTime, dateFrom: '01/01/2026' },
    });
    expect(error).to.match(/ISO dates/);
  });

  it('rejects dateFrom after dateTo', () => {
    const { error } = validateAnalysisRequest({
      metric: 'visibilityScore', time: { ...validTime, dateFrom: '2026-02-01', dateTo: '2026-01-01' },
    });
    expect(error).to.match(/must not be after/);
  });

  it('rejects a filter on a non-filterable dimension (week)', () => {
    const { error } = validateAnalysisRequest({
      metric: 'visibilityScore',
      time: validTime,
      filters: [{ dimension: 'week', operator: 'equals', values: ['2026-01-01'] }],
    });
    expect(error).to.match(/not filterable/);
  });

  it('rejects an unsupported filter operator for the dimension type', () => {
    const { error } = validateAnalysisRequest({
      metric: 'visibilityScore',
      time: validTime,
      filters: [{ dimension: 'platform', operator: 'dateRange', values: ['chatgpt-paid'] }],
    });
    expect(error).to.match(/Unsupported filter operator/);
  });

  it('rejects an empty filter values array', () => {
    const { error } = validateAnalysisRequest({
      metric: 'visibilityScore',
      time: validTime,
      filters: [{ dimension: 'platform', operator: 'in', values: [] }],
    });
    expect(error).to.match(/non-empty array/);
  });

  it('rejects a filter value not in the dimension allowlist', () => {
    const { error } = validateAnalysisRequest({
      metric: 'visibilityScore',
      time: validTime,
      filters: [{ dimension: 'platform', operator: 'in', values: ['not-a-real-platform'] }],
    });
    expect(error).to.match(/Unsupported value/);
  });

  it('rejects a sort.by that is neither the metric nor a requested dimension', () => {
    const { error } = validateAnalysisRequest({
      metric: 'visibilityScore',
      dimensions: ['platform'],
      time: validTime,
      sort: { by: 'topic', direction: 'asc' },
    });
    expect(error).to.match(/sort.by must be/);
  });

  it('rejects a limit outside [1, 500]', () => {
    const { error } = validateAnalysisRequest({
      metric: 'visibilityScore', time: validTime, limit: 0,
    });
    expect(error).to.match(/limit must be/);
  });

  it('normalizes a missing limit to the default', () => {
    const { value } = validateAnalysisRequest({ metric: 'visibilityScore', time: validTime });
    expect(value.limit).to.equal(100);
  });
});

describe('LlmoAnalyticsController', () => {
  let sandbox;
  let mockContext;
  let mockOrganization;
  let LlmoAnalyticsController;

  beforeEach(async () => {
    sandbox = sinon.createSandbox();
    mockOrganization = { getId: sandbox.stub().returns('org-123') };

    LlmoAnalyticsController = (await esmock('../../../src/controllers/llmo/llmo-analytics.js', {
      '../../../src/support/access-control-util.js': {
        default: {
          fromContext: () => ({ hasAccess: sandbox.stub().resolves(true) }),
        },
      },
    })).default;

    mockContext = {
      params: { spaceCatId: 'org-123', brandId: 'brand-123' },
      dataAccess: {
        Organization: { findById: sandbox.stub().resolves(mockOrganization) },
      },
      attributes: {
        authInfo: { getProfile: () => ({ email: 'user@example.com' }) },
      },
      data: {},
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('getMetadata returns the governed catalog', async () => {
    const controller = LlmoAnalyticsController(mockContext);
    const response = await controller.getMetadata(mockContext);
    expect(response.status).to.equal(200);
    const body = await response.json();
    expect(body.metrics).to.be.an('array').with.length.greaterThan(0);
    expect(body.dimensions).to.be.an('array').with.length.greaterThan(0);
    expect(body.grains).to.deep.equal(['week']);
  });

  it('getMetadata 404s when the organization is not found', async () => {
    mockContext.dataAccess.Organization.findById.resolves(null);
    const controller = LlmoAnalyticsController(mockContext);
    const response = await controller.getMetadata(mockContext);
    expect(response.status).to.equal(404);
  });

  it('runQuery returns fixture rows for a valid Analysis', async () => {
    mockContext.data = {
      metric: 'visibilityScore',
      dimensions: ['platform'],
      time: { grain: 'week', dateFrom: '2026-01-05', dateTo: '2026-01-05' },
    };
    const controller = LlmoAnalyticsController(mockContext);
    const response = await controller.runQuery(mockContext);
    expect(response.status).to.equal(200);
    const body = await response.json();
    expect(body.rows).to.have.lengthOf(6); // 6 platforms
    expect(body.meta.rowCount).to.equal(6);
  });

  it('runQuery 400s on an invalid Analysis', async () => {
    mockContext.data = { metric: 'not-a-metric' };
    const controller = LlmoAnalyticsController(mockContext);
    const response = await controller.runQuery(mockContext);
    expect(response.status).to.equal(400);
  });

  it('runQuery applies sort and limit', async () => {
    mockContext.data = {
      metric: 'visibilityScore',
      dimensions: ['platform'],
      time: { grain: 'week', dateFrom: '2026-01-05', dateTo: '2026-01-05' },
      sort: { by: 'visibilityScore', direction: 'desc' },
      limit: 2,
    };
    const controller = LlmoAnalyticsController(mockContext);
    const response = await controller.runQuery(mockContext);
    const body = await response.json();
    expect(body.rows).to.have.lengthOf(2);
    expect(body.meta.truncated).to.be.true;
    expect(body.rows[0].visibilityScore).to.be.at.least(body.rows[1].visibilityScore);
  });
});
