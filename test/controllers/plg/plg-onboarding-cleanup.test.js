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

import { expect, use } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';

import {
  cleanupPlgSiteSuggestionsAndFixes,
  PLG_CLEANUP_OPPORTUNITY_TYPES,
  STATUSES_TO_OUTDATE,
  STATUSES_TO_RESET_TO_NEW,
} from '../../../src/controllers/plg/plg-onboarding-cleanup.js';

use(sinonChai);

const SITE_ID = 'site-uuid-1';

const EMPTY_RESULT = { outdatedCount: 0, resetToNewCount: 0, removedFixCount: 0 };

function createMockOpportunity(id, type) {
  return {
    getId: sinon.stub().returns(id),
    getType: sinon.stub().returns(type),
  };
}

function createMockSuggestion(id, status) {
  return {
    getId: sinon.stub().returns(id),
    getStatus: sinon.stub().returns(status),
    setStatus: sinon.stub(),
  };
}

function createMockFixEntity(id) {
  return {
    getId: sinon.stub().returns(id),
  };
}

describe('cleanupPlgSiteSuggestionsAndFixes', () => {
  let sandbox;
  let log;
  let dataAccess;
  let context;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    log = {
      info: sandbox.stub(),
      warn: sandbox.stub(),
      error: sandbox.stub(),
    };
    dataAccess = {
      Opportunity: {
        allBySiteId: sandbox.stub().resolves([]),
      },
      Suggestion: {
        allByOpportunityId: sandbox.stub().resolves([]),
        bulkUpdateStatus: sandbox.stub().resolves(),
      },
      FixEntity: {
        allByOpportunityId: sandbox.stub().resolves([]),
        removeByIds: sandbox.stub().resolves(),
      },
    };
    context = { dataAccess, log };
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('exports the PLG opportunity types covered by cleanup', () => {
    expect(PLG_CLEANUP_OPPORTUNITY_TYPES).to.deep.equal([
      'cwv',
      'alt-text',
      'broken-backlinks',
    ]);
  });

  it('exports the status sets the cleanup transitions', () => {
    expect([...STATUSES_TO_OUTDATE]).to.have.members([
      'FIXED',
      'IN_PROGRESS',
      'SKIPPED',
      'ERROR',
      'REJECTED',
    ]);
    expect([...STATUSES_TO_RESET_TO_NEW]).to.deep.equal(['PENDING_VALIDATION']);
  });

  it('skips when no siteId is provided', async () => {
    const result = await cleanupPlgSiteSuggestionsAndFixes(null, context);

    expect(result).to.deep.equal(EMPTY_RESULT);
    expect(dataAccess.Opportunity.allBySiteId).to.not.have.been.called;
    expect(log.info).to.have.been.calledWithMatch(/no siteId provided, skipping/);
  });

  it('returns zero counts when listing opportunities fails', async () => {
    dataAccess.Opportunity.allBySiteId.rejects(new Error('DB unavailable'));

    const result = await cleanupPlgSiteSuggestionsAndFixes(SITE_ID, context);

    expect(result).to.deep.equal(EMPTY_RESULT);
    expect(log.warn).to.have.been.calledWithMatch(/failed to list opportunities/);
  });

  it('returns zero counts when site has no PLG opportunities', async () => {
    dataAccess.Opportunity.allBySiteId.resolves([
      createMockOpportunity('o1', 'structured-data'),
      createMockOpportunity('o2', 'product-meta'),
    ]);

    const result = await cleanupPlgSiteSuggestionsAndFixes(SITE_ID, context);

    expect(result).to.deep.equal(EMPTY_RESULT);
    expect(dataAccess.Suggestion.allByOpportunityId).to.not.have.been.called;
    expect(dataAccess.FixEntity.allByOpportunityId).to.not.have.been.called;
    expect(log.info).to.have.been.calledWithMatch(/no PLG opportunities found/);
  });

  it('outdates configured statuses, resets PENDING_VALIDATION to NEW, and removes fix entities for PLG opportunities only', async () => {
    const cwvOppty = createMockOpportunity('o-cwv', 'cwv');
    const altTextOppty = createMockOpportunity('o-alt', 'alt-text');
    const brokenBacklinksOppty = createMockOpportunity('o-bb', 'broken-backlinks');
    const otherOppty = createMockOpportunity('o-other', 'structured-data');

    dataAccess.Opportunity.allBySiteId.resolves([
      cwvOppty, altTextOppty, brokenBacklinksOppty, otherOppty,
    ]);

    // cwv: mix of statuses across both buckets and statuses that should be left alone.
    const cwvFixed = createMockSuggestion('s-cwv-fixed', 'FIXED');
    const cwvInProgress = createMockSuggestion('s-cwv-inprog', 'IN_PROGRESS');
    const cwvSkipped = createMockSuggestion('s-cwv-skip', 'SKIPPED');
    const cwvPending = createMockSuggestion('s-cwv-pending', 'PENDING_VALIDATION');
    const cwvNew = createMockSuggestion('s-cwv-new', 'NEW'); // untouched
    const cwvApproved = createMockSuggestion('s-cwv-app', 'APPROVED'); // untouched
    const altError = createMockSuggestion('s-alt-err', 'ERROR');
    const altRejected = createMockSuggestion('s-alt-rej', 'REJECTED');
    const altPending = createMockSuggestion('s-alt-pending', 'PENDING_VALIDATION');
    // broken-backlinks has only NEW suggestions → no transitions, but fix entities exist.
    const bbNew = createMockSuggestion('s-bb-new', 'NEW');

    dataAccess.Suggestion.allByOpportunityId
      .withArgs('o-cwv').resolves([
        cwvFixed, cwvInProgress, cwvSkipped, cwvPending, cwvNew, cwvApproved,
      ])
      .withArgs('o-alt').resolves([altError, altRejected, altPending])
      .withArgs('o-bb')
      .resolves([bbNew]);

    const cwvFixes = [
      createMockFixEntity('f1'), createMockFixEntity('f2'), createMockFixEntity('f3'),
    ];
    const bbFixes = [createMockFixEntity('f4')];
    dataAccess.FixEntity.allByOpportunityId
      .withArgs('o-cwv').resolves(cwvFixes)
      .withArgs('o-alt').resolves([])
      .withArgs('o-bb')
      .resolves(bbFixes);

    const result = await cleanupPlgSiteSuggestionsAndFixes(SITE_ID, context);

    expect(result).to.deep.equal({
      outdatedCount: 5, // cwv: 3 (FIXED, IN_PROGRESS, SKIPPED) + alt: 2 (ERROR, REJECTED)
      resetToNewCount: 2, // cwv: 1 + alt: 1
      removedFixCount: 4, // cwv: 3 + bb: 1
    });

    // Non-PLG opportunity is skipped entirely.
    expect(dataAccess.Suggestion.allByOpportunityId)
      .to.not.have.been.calledWith('o-other');
    expect(dataAccess.FixEntity.allByOpportunityId)
      .to.not.have.been.calledWith('o-other');

    // OUTDATED bulk updates (one per opportunity that had outdate-worthy suggestions).
    expect(dataAccess.Suggestion.bulkUpdateStatus).to.have.been.calledWith(
      [cwvFixed, cwvInProgress, cwvSkipped],
      'OUTDATED',
    );
    expect(dataAccess.Suggestion.bulkUpdateStatus).to.have.been.calledWith(
      [altError, altRejected],
      'OUTDATED',
    );

    // PENDING_VALIDATION → NEW resets.
    expect(dataAccess.Suggestion.bulkUpdateStatus).to.have.been.calledWith(
      [cwvPending],
      'NEW',
    );
    expect(dataAccess.Suggestion.bulkUpdateStatus).to.have.been.calledWith(
      [altPending],
      'NEW',
    );

    // NEW / APPROVED suggestions are never passed to bulkUpdateStatus.
    const allBulkCalls = dataAccess.Suggestion.bulkUpdateStatus.getCalls();
    const allUpdatedSuggestions = allBulkCalls.flatMap((call) => call.args[0]);
    expect(allUpdatedSuggestions).to.not.include(cwvNew);
    expect(allUpdatedSuggestions).to.not.include(cwvApproved);
    expect(allUpdatedSuggestions).to.not.include(bbNew);

    // Fix entity removals.
    expect(dataAccess.FixEntity.removeByIds).to.have.been.calledTwice;
    expect(dataAccess.FixEntity.removeByIds).to.have.been.calledWith(['f1', 'f2', 'f3']);
    expect(dataAccess.FixEntity.removeByIds).to.have.been.calledWith(['f4']);

    expect(log.info).to.have.been.calledWithMatch(/PLG cleanup complete for site/);
  });

  it('logs and continues when listing suggestions fails for one opportunity', async () => {
    const cwvOppty = createMockOpportunity('o-cwv', 'cwv');
    const altTextOppty = createMockOpportunity('o-alt', 'alt-text');
    dataAccess.Opportunity.allBySiteId.resolves([cwvOppty, altTextOppty]);

    dataAccess.Suggestion.allByOpportunityId
      .withArgs('o-cwv').rejects(new Error('lookup boom'))
      .withArgs('o-alt')
      .resolves([
        createMockSuggestion('s-alt-fixed', 'FIXED'),
        createMockSuggestion('s-alt-pending', 'PENDING_VALIDATION'),
      ]);

    dataAccess.FixEntity.allByOpportunityId.resolves([]);

    const result = await cleanupPlgSiteSuggestionsAndFixes(SITE_ID, context);

    expect(result).to.deep.equal({
      outdatedCount: 1,
      resetToNewCount: 1,
      removedFixCount: 0,
    });
    expect(log.warn).to.have.been.calledWithMatch(/failed to list suggestions for cwv/);
    expect(dataAccess.Suggestion.bulkUpdateStatus).to.have.been.calledTwice;
  });

  it('logs and continues when the OUTDATED transition fails but the NEW reset succeeds', async () => {
    dataAccess.Opportunity.allBySiteId.resolves([
      createMockOpportunity('o-cwv', 'cwv'),
    ]);
    dataAccess.Suggestion.allByOpportunityId.resolves([
      createMockSuggestion('s1', 'FIXED'),
      createMockSuggestion('s2', 'PENDING_VALIDATION'),
    ]);
    dataAccess.Suggestion.bulkUpdateStatus
      .withArgs(sinon.match.any, 'OUTDATED').rejects(new Error('save failed'))
      .withArgs(sinon.match.any, 'NEW')
      .resolves();

    const result = await cleanupPlgSiteSuggestionsAndFixes(SITE_ID, context);

    expect(result).to.deep.equal({
      outdatedCount: 0,
      resetToNewCount: 1,
      removedFixCount: 0,
    });
    expect(log.warn).to.have.been.calledWithMatch(/failed to transition cwv suggestions to OUTDATED/);
  });

  it('logs and continues when the NEW reset fails but the OUTDATED transition succeeds', async () => {
    dataAccess.Opportunity.allBySiteId.resolves([
      createMockOpportunity('o-cwv', 'cwv'),
    ]);
    dataAccess.Suggestion.allByOpportunityId.resolves([
      createMockSuggestion('s1', 'FIXED'),
      createMockSuggestion('s2', 'PENDING_VALIDATION'),
    ]);
    dataAccess.Suggestion.bulkUpdateStatus
      .withArgs(sinon.match.any, 'NEW').rejects(new Error('reset failed'))
      .withArgs(sinon.match.any, 'OUTDATED')
      .resolves();

    const result = await cleanupPlgSiteSuggestionsAndFixes(SITE_ID, context);

    expect(result).to.deep.equal({
      outdatedCount: 1,
      resetToNewCount: 0,
      removedFixCount: 0,
    });
    expect(log.warn).to.have.been.calledWithMatch(/failed to transition cwv suggestions to NEW/);
  });

  it('logs and continues when removing fix entities fails', async () => {
    dataAccess.Opportunity.allBySiteId.resolves([
      createMockOpportunity('o-cwv', 'cwv'),
    ]);
    dataAccess.Suggestion.allByOpportunityId.resolves([]);

    dataAccess.FixEntity.allByOpportunityId.resolves([
      createMockFixEntity('f1'),
    ]);
    dataAccess.FixEntity.removeByIds.rejects(new Error('delete blew up'));

    const result = await cleanupPlgSiteSuggestionsAndFixes(SITE_ID, context);

    expect(result).to.deep.equal(EMPTY_RESULT);
    expect(log.warn).to.have.been.calledWithMatch(/failed to remove fix entities for cwv/);
  });

  it('logs and continues when listing fix entities throws', async () => {
    dataAccess.Opportunity.allBySiteId.resolves([
      createMockOpportunity('o-cwv', 'cwv'),
    ]);
    dataAccess.Suggestion.allByOpportunityId.resolves([]);
    dataAccess.FixEntity.allByOpportunityId.rejects(new Error('list boom'));

    const result = await cleanupPlgSiteSuggestionsAndFixes(SITE_ID, context);

    expect(result).to.deep.equal(EMPTY_RESULT);
    expect(log.warn).to.have.been.calledWithMatch(/list boom/);
    expect(dataAccess.FixEntity.removeByIds).to.not.have.been.called;
  });

  it('skips bulkUpdateStatus calls when no suggestions match either transition set', async () => {
    dataAccess.Opportunity.allBySiteId.resolves([
      createMockOpportunity('o-cwv', 'cwv'),
    ]);
    // Only NEW + APPROVED → neither bucket should match.
    dataAccess.Suggestion.allByOpportunityId.resolves([
      createMockSuggestion('s1', 'NEW'),
      createMockSuggestion('s2', 'APPROVED'),
    ]);
    dataAccess.FixEntity.allByOpportunityId.resolves([]);

    const result = await cleanupPlgSiteSuggestionsAndFixes(SITE_ID, context);

    expect(result).to.deep.equal(EMPTY_RESULT);
    expect(dataAccess.Suggestion.bulkUpdateStatus).to.not.have.been.called;
    expect(dataAccess.FixEntity.removeByIds).to.not.have.been.called;
  });
});
