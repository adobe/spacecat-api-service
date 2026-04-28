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
} from '../../../src/controllers/plg/plg-onboarding-cleanup.js';

use(sinonChai);

const SITE_ID = 'site-uuid-1';

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
        allByOpportunityIdAndStatus: sandbox.stub().resolves([]),
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

  it('skips when no siteId is provided', async () => {
    const result = await cleanupPlgSiteSuggestionsAndFixes(null, context);

    expect(result).to.deep.equal({ outdatedCount: 0, removedFixCount: 0 });
    expect(dataAccess.Opportunity.allBySiteId).to.not.have.been.called;
    expect(log.info).to.have.been.calledWithMatch(/no siteId provided, skipping/);
  });

  it('returns zero counts when listing opportunities fails', async () => {
    dataAccess.Opportunity.allBySiteId.rejects(new Error('DB unavailable'));

    const result = await cleanupPlgSiteSuggestionsAndFixes(SITE_ID, context);

    expect(result).to.deep.equal({ outdatedCount: 0, removedFixCount: 0 });
    expect(log.warn).to.have.been.calledWithMatch(/failed to list opportunities/);
  });

  it('returns zero counts when site has no PLG opportunities', async () => {
    dataAccess.Opportunity.allBySiteId.resolves([
      createMockOpportunity('o1', 'structured-data'),
      createMockOpportunity('o2', 'product-meta'),
    ]);

    const result = await cleanupPlgSiteSuggestionsAndFixes(SITE_ID, context);

    expect(result).to.deep.equal({ outdatedCount: 0, removedFixCount: 0 });
    expect(dataAccess.Suggestion.allByOpportunityIdAndStatus).to.not.have.been.called;
    expect(dataAccess.FixEntity.allByOpportunityId).to.not.have.been.called;
    expect(log.info).to.have.been.calledWithMatch(/no PLG opportunities found/);
  });

  it('outdates FIXED suggestions and removes fix entities for PLG opportunities only', async () => {
    const cwvOppty = createMockOpportunity('o-cwv', 'cwv');
    const altTextOppty = createMockOpportunity('o-alt', 'alt-text');
    const brokenBacklinksOppty = createMockOpportunity('o-bb', 'broken-backlinks');
    const otherOppty = createMockOpportunity('o-other', 'structured-data');

    dataAccess.Opportunity.allBySiteId.resolves([
      cwvOppty, altTextOppty, brokenBacklinksOppty, otherOppty,
    ]);

    const cwvFixed = [createMockSuggestion('s1', 'FIXED'), createMockSuggestion('s2', 'FIXED')];
    const altFixed = [createMockSuggestion('s3', 'FIXED')];
    dataAccess.Suggestion.allByOpportunityIdAndStatus
      .withArgs('o-cwv', 'FIXED').resolves(cwvFixed)
      .withArgs('o-alt', 'FIXED').resolves(altFixed)
      .withArgs('o-bb', 'FIXED')
      .resolves([]);

    const cwvFixes = [createMockFixEntity('f1'), createMockFixEntity('f2'), createMockFixEntity('f3')];
    const bbFixes = [createMockFixEntity('f4')];
    dataAccess.FixEntity.allByOpportunityId
      .withArgs('o-cwv').resolves(cwvFixes)
      .withArgs('o-alt').resolves([])
      .withArgs('o-bb')
      .resolves(bbFixes);

    const result = await cleanupPlgSiteSuggestionsAndFixes(SITE_ID, context);

    expect(result).to.deep.equal({ outdatedCount: 3, removedFixCount: 4 });

    // Non-PLG opportunity is skipped entirely.
    expect(dataAccess.Suggestion.allByOpportunityIdAndStatus)
      .to.not.have.been.calledWith('o-other', sinon.match.any);
    expect(dataAccess.FixEntity.allByOpportunityId)
      .to.not.have.been.calledWith('o-other');

    // bulkUpdateStatus called once per opportunity that had FIXED suggestions.
    expect(dataAccess.Suggestion.bulkUpdateStatus).to.have.been.calledTwice;
    expect(dataAccess.Suggestion.bulkUpdateStatus).to.have.been.calledWith(cwvFixed, 'OUTDATED');
    expect(dataAccess.Suggestion.bulkUpdateStatus).to.have.been.calledWith(altFixed, 'OUTDATED');

    // removeByIds called once per opportunity that had fix entities.
    expect(dataAccess.FixEntity.removeByIds).to.have.been.calledTwice;
    expect(dataAccess.FixEntity.removeByIds).to.have.been.calledWith(['f1', 'f2', 'f3']);
    expect(dataAccess.FixEntity.removeByIds).to.have.been.calledWith(['f4']);

    expect(log.info).to.have.been.calledWithMatch(/PLG cleanup complete for site/);
  });

  it('logs and continues when outdating FIXED suggestions fails for one opportunity', async () => {
    const cwvOppty = createMockOpportunity('o-cwv', 'cwv');
    const altTextOppty = createMockOpportunity('o-alt', 'alt-text');
    dataAccess.Opportunity.allBySiteId.resolves([cwvOppty, altTextOppty]);

    dataAccess.Suggestion.allByOpportunityIdAndStatus
      .withArgs('o-cwv', 'FIXED').rejects(new Error('lookup boom'))
      .withArgs('o-alt', 'FIXED')
      .resolves([createMockSuggestion('s1', 'FIXED')]);

    dataAccess.FixEntity.allByOpportunityId.resolves([]);

    const result = await cleanupPlgSiteSuggestionsAndFixes(SITE_ID, context);

    expect(result).to.deep.equal({ outdatedCount: 1, removedFixCount: 0 });
    expect(log.warn).to.have.been.calledWithMatch(/failed to mark FIXED suggestions OUTDATED for cwv/);
    expect(dataAccess.Suggestion.bulkUpdateStatus).to.have.been.calledOnce;
  });

  it('logs and continues when bulkUpdateStatus rejects', async () => {
    dataAccess.Opportunity.allBySiteId.resolves([
      createMockOpportunity('o-cwv', 'cwv'),
    ]);
    dataAccess.Suggestion.allByOpportunityIdAndStatus.resolves([
      createMockSuggestion('s1', 'FIXED'),
    ]);
    dataAccess.Suggestion.bulkUpdateStatus.rejects(new Error('save failed'));

    const result = await cleanupPlgSiteSuggestionsAndFixes(SITE_ID, context);

    expect(result).to.deep.equal({ outdatedCount: 0, removedFixCount: 0 });
    expect(log.warn).to.have.been.calledWithMatch(/save failed/);
  });

  it('logs and continues when removing fix entities fails', async () => {
    dataAccess.Opportunity.allBySiteId.resolves([
      createMockOpportunity('o-cwv', 'cwv'),
    ]);
    dataAccess.Suggestion.allByOpportunityIdAndStatus.resolves([]);

    dataAccess.FixEntity.allByOpportunityId.resolves([
      createMockFixEntity('f1'),
    ]);
    dataAccess.FixEntity.removeByIds.rejects(new Error('delete blew up'));

    const result = await cleanupPlgSiteSuggestionsAndFixes(SITE_ID, context);

    expect(result).to.deep.equal({ outdatedCount: 0, removedFixCount: 0 });
    expect(log.warn).to.have.been.calledWithMatch(/failed to remove fix entities for cwv/);
  });

  it('logs and continues when listing fix entities throws', async () => {
    dataAccess.Opportunity.allBySiteId.resolves([
      createMockOpportunity('o-cwv', 'cwv'),
    ]);
    dataAccess.Suggestion.allByOpportunityIdAndStatus.resolves([]);
    dataAccess.FixEntity.allByOpportunityId.rejects(new Error('list boom'));

    const result = await cleanupPlgSiteSuggestionsAndFixes(SITE_ID, context);

    expect(result).to.deep.equal({ outdatedCount: 0, removedFixCount: 0 });
    expect(log.warn).to.have.been.calledWithMatch(/list boom/);
    expect(dataAccess.FixEntity.removeByIds).to.not.have.been.called;
  });

  it('skips bulkUpdateStatus when no FIXED suggestions exist for the opportunity', async () => {
    dataAccess.Opportunity.allBySiteId.resolves([
      createMockOpportunity('o-cwv', 'cwv'),
    ]);
    dataAccess.Suggestion.allByOpportunityIdAndStatus.resolves([]);
    dataAccess.FixEntity.allByOpportunityId.resolves([]);

    const result = await cleanupPlgSiteSuggestionsAndFixes(SITE_ID, context);

    expect(result).to.deep.equal({ outdatedCount: 0, removedFixCount: 0 });
    expect(dataAccess.Suggestion.bulkUpdateStatus).to.not.have.been.called;
    expect(dataAccess.FixEntity.removeByIds).to.not.have.been.called;
  });
});
