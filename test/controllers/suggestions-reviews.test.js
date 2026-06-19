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

/* eslint-env mocha */

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import esmock from 'esmock';

use(chaiAsPromised);
use(sinonChai);

const SITE_ID = 'f964a7f8-5402-4b01-bd5b-1ab499bcf797';
const OPPORTUNITY_ID = 'a92e2a5e-7b3d-42f0-b3f0-6edd3746a932';
const SUGGESTION_ID = 'a4a6055c-de4b-4552-bc0c-01fdb45b98d5';
const EVENT_ID = '9beae43f-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const ORG_ID = '5f3a8b2c-1d4e-4f6a-9b0c-1d2e3f4a5b6c';

/**
 * Chainable PostgREST mock supporting the three call shapes used by the
 * controller:
 *   insert(row).select().single()            -> onInsert
 *   select('*').eq(...).single()             -> onSelectSingle (duplicate fetch)
 *   select('*').eq(...).order(...)           -> onOrder (review list)
 */
function makePostgrestClient({ onInsert, onSelectSingle, onOrder } = {}) {
  return {
    from() {
      let inserted = false;
      const chain = {
        insert() { inserted = true; return chain; },
        select() { return chain; },
        eq() { return chain; },
        order() {
          return Promise.resolve(onOrder ? onOrder() : { data: [], error: null });
        },
        single() {
          if (inserted) {
            return Promise.resolve(onInsert ? onInsert() : { data: {}, error: null });
          }
          return Promise.resolve(onSelectSingle ? onSelectSingle() : { data: null, error: null });
        },
      };
      return chain;
    },
  };
}

describe('Suggestions Controller - backoffice reviews', () => {
  const sandbox = sinon.createSandbox();

  let SuggestionsController;
  let controller;
  let accessAllowed;
  let site;
  let suggestion;
  let opportunity;
  let mockDataAccess;
  let log;

  const baseBody = () => ({
    eventId: EVENT_ID,
    verdict: 'down',
    detailMarkdown: 'targets the wrong property',
    rejectionCategory: 'bad_recommendation',
    stateTransition: 'PENDING_VALIDATION->REJECTED',
    previousFix: { patch: 'before' },
  });

  const makeContext = (overrides = {}) => ({
    params: { siteId: SITE_ID, opportunityId: OPPORTUNITY_ID, suggestionId: SUGGESTION_ID },
    data: baseBody(),
    attributes: { authInfo: { profile: { email: 'ese@adobe.com' } } },
    log,
    dataAccess: { services: { postgrestClient: makePostgrestClient(overrides.postgrest) } },
    ...overrides.context,
  });

  beforeEach(async () => {
    accessAllowed = true;
    log = {
      info: sandbox.stub(), warn: sandbox.stub(), error: sandbox.stub(), debug: sandbox.stub(),
    };

    opportunity = {
      getSiteId: () => SITE_ID,
      getType: () => 'cwv',
    };
    suggestion = {
      getId: () => SUGGESTION_ID,
      getOpportunityId: () => OPPORTUNITY_ID,
      getOpportunity: async () => opportunity,
    };
    site = {
      getId: () => SITE_ID,
      getOrganizationId: () => ORG_ID,
      getSiteEnrollments: async () => [],
    };

    mockDataAccess = {
      Opportunity: { findById: sandbox.stub() },
      Suggestion: { findById: sandbox.stub().resolves(suggestion) },
      SuggestionGrant: {},
      Site: { findById: sandbox.stub().resolves(site) },
      GeoExperiment: {},
    };

    SuggestionsController = await esmock('../../src/controllers/suggestions.js', {
      '../../src/support/access-control-util.js': {
        default: { fromContext: () => ({ hasAccess: async () => accessAllowed }) },
      },
    });

    controller = SuggestionsController(
      { dataAccess: mockDataAccess, log },
      {},
      {},
    );
  });

  afterEach(() => sandbox.restore());

  it('records a review and returns 201 with the review view (no raw patch)', async () => {
    const insertedRow = {
      event_id: EVENT_ID,
      event_time: '2026-06-19T18:00:00.000Z',
      source: 'backoffice',
      signal: 'negative',
      reviewer_id: 'ese@adobe.com',
      detail_markdown: 'targets the wrong property',
      rejection_category: 'bad_recommendation',
      state_transition: 'PENDING_VALIDATION->REJECTED',
      tier: 'free',
      previous_fix: { patch: 'before' },
    };
    const context = makeContext({ postgrest: { onInsert: () => ({ data: insertedRow, error: null }) } });

    const response = await controller.createBackofficeReview(context);
    expect(response.status).to.equal(201);
    const result = await response.json();
    expect(result.eventId).to.equal(EVENT_ID);
    expect(result.verdict).to.equal('down');
    expect(result.signal).to.equal('negative');
    expect(result).to.not.have.property('previousFix');
  });

  it('rejects a missing event_id with 400 (FR-09)', async () => {
    const context = makeContext();
    delete context.data.eventId;
    const response = await controller.createBackofficeReview(context);
    expect(response.status).to.equal(400);
  });

  it('rejects a non-UUID event_id with 400', async () => {
    const context = makeContext();
    context.data.eventId = 'not-a-uuid';
    const response = await controller.createBackofficeReview(context);
    expect(response.status).to.equal(400);
  });

  it('rejects an invalid verdict with 400', async () => {
    const context = makeContext();
    context.data.verdict = 'maybe';
    const response = await controller.createBackofficeReview(context);
    expect(response.status).to.equal(400);
  });

  it('rejects a body-supplied source that mismatches the route with 400 (FR-10)', async () => {
    const context = makeContext();
    context.data.source = 'aso_ui';
    const response = await controller.createBackofficeReview(context);
    expect(response.status).to.equal(400);
  });

  it('rejects an invalid rejection_category with 400', async () => {
    const context = makeContext();
    context.data.rejectionCategory = 'nope';
    const response = await controller.createBackofficeReview(context);
    expect(response.status).to.equal(400);
  });

  it('rejects oversize detail_markdown with 413', async () => {
    const context = makeContext();
    context.data.detailMarkdown = 'x'.repeat(8193);
    const response = await controller.createBackofficeReview(context);
    expect(response.status).to.equal(413);
  });

  it('returns 404 when the site is not found', async () => {
    mockDataAccess.Site.findById.resolves(null);
    const response = await controller.createBackofficeReview(makeContext());
    expect(response.status).to.equal(404);
  });

  it('returns 403 when the caller lacks access to the org', async () => {
    accessAllowed = false;
    const response = await controller.createBackofficeReview(makeContext());
    expect(response.status).to.equal(403);
  });

  it('returns 404 when the suggestion does not belong to the opportunity', async () => {
    mockDataAccess.Suggestion.findById.resolves({
      getId: () => SUGGESTION_ID,
      getOpportunityId: () => 'b56ef8d6-996b-4d5c-b308-8e0b0a95e1b6',
      getOpportunity: async () => opportunity,
    });
    const response = await controller.createBackofficeReview(makeContext());
    expect(response.status).to.equal(404);
  });

  it('is idempotent: a duplicate event_id returns 200 with the existing row', async () => {
    const existing = {
      event_id: EVENT_ID, event_time: 't', source: 'backoffice', signal: 'negative', tier: 'free',
    };
    const context = makeContext({
      postgrest: {
        onInsert: () => ({ data: null, error: { code: '23505', message: 'duplicate' } }),
        onSelectSingle: () => ({ data: existing, error: null }),
      },
    });
    const response = await controller.createBackofficeReview(context);
    expect(response.status).to.equal(200);
    const result = await response.json();
    expect(result.eventId).to.equal(EVENT_ID);
  });

  it('returns 500 on a non-conflict insert error', async () => {
    const context = makeContext({
      postgrest: { onInsert: () => ({ data: null, error: { code: '42P01', message: 'boom' } }) },
    });
    const response = await controller.createBackofficeReview(context);
    expect(response.status).to.equal(500);
  });

  it('returns 503 when the feedback store is unavailable', async () => {
    const context = makeContext();
    context.dataAccess = { services: {} };
    const response = await controller.createBackofficeReview(context);
    expect(response.status).to.equal(503);
  });
});
