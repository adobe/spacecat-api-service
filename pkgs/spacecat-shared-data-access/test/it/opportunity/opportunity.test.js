/*
 * Copyright 2024 Adobe. All rights reserved.
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

import { isIsoDate } from '@adobe/spacecat-shared-utils';

import { expect, use } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import { v4 as uuid, validate as uuidValidate } from 'uuid';

import { ValidationError } from '../../../src/index.js';

import fixtures from '../../fixtures/index.fixtures.js';
import { getDataAccess } from '../util/db.js';
import { seedDatabase } from '../util/seed.js';
import { sanitizeIdAndAuditFields, sanitizeTimestamps } from '../../../src/util/util.js';

use(chaiAsPromised);
use(sinonChai);

describe('Opportunity IT', async () => {
  const { siteId } = fixtures.sites[0];

  let sampleData;
  let mockLogger;

  let Opportunity;
  let Suggestion;

  before(async () => {
    sampleData = await seedDatabase();
  });

  beforeEach(() => {
    mockLogger = {
      debug: sinon.stub(),
      error: sinon.stub(),
      info: sinon.stub(),
      warn: sinon.stub(),
    };

    const dataAccess = getDataAccess({}, mockLogger);
    Opportunity = dataAccess.Opportunity;
    Suggestion = dataAccess.Suggestion;
  });

  afterEach(() => {
    sinon.restore();
  });

  it('finds one opportunity by id', async () => {
    const opportunity = await Opportunity.findById(sampleData.opportunities[0].getId());

    expect(opportunity).to.be.an('object');
    expect(
      sanitizeTimestamps(opportunity.toJSON()),
    ).to.eql(
      sanitizeTimestamps(sampleData.opportunities[0].toJSON()),
    );

    const suggestions = await opportunity.getSuggestions();
    expect(suggestions).to.be.an('array').with.length(3);

    const parentOpportunity = await suggestions[0].getOpportunity();
    expect(parentOpportunity).to.be.an('object');
    expect(
      sanitizeTimestamps(opportunity.toJSON()),
    ).to.eql(
      sanitizeTimestamps(sampleData.opportunities[0].toJSON()),
    );
  });

  it('finds all opportunities by siteId and status', async () => {
    const opportunities = await Opportunity.allBySiteIdAndStatus(siteId, 'NEW');

    expect(opportunities).to.be.an('array').with.length(2);
  });

  it('partially updates one opportunity by id', async () => {
    // retrieve the opportunity by ID
    const opportunity = await Opportunity.findById(sampleData.opportunities[0].getId());
    expect(opportunity).to.be.an('object');
    expect(
      sanitizeTimestamps(opportunity.toJSON()),
    ).to.eql(
      sanitizeTimestamps(sampleData.opportunities[0].toJSON()),
    );

    // apply updates
    const updates = {
      runbook: 'https://example-updated.com',
      status: 'IN_PROGRESS',
    };

    opportunity
      .setRunbook(updates.runbook)
      .setStatus(updates.status);

    // opportunity.setAuditId('invalid-audit-id');

    await opportunity.save();

    expect(opportunity.getRunbook()).to.equal(updates.runbook);
    expect(opportunity.getStatus()).to.equal(updates.status);

    const updated = sanitizeTimestamps(opportunity.toJSON());
    delete updated.runbook;
    delete updated.status;

    const original = sanitizeTimestamps(sampleData.opportunities[0].toJSON());
    delete original.runbook;
    delete original.status;

    expect(updated).to.eql(original);

    const storedOpportunity = await Opportunity.findById(sampleData.opportunities[0].getId());
    expect(storedOpportunity.getRunbook()).to.equal(updates.runbook);
    expect(storedOpportunity.getStatus()).to.equal(updates.status);

    const storedWithoutUpdatedAt = { ...storedOpportunity.toJSON() };
    const inMemoryWithoutUpdatedAt = { ...opportunity.toJSON() };
    delete storedWithoutUpdatedAt.updatedAt;
    delete inMemoryWithoutUpdatedAt.updatedAt;

    expect(storedWithoutUpdatedAt).to.eql(inMemoryWithoutUpdatedAt);
  });

  it('finds all opportunities by siteId', async () => {
    const opportunities = await Opportunity.allBySiteId(siteId);

    expect(opportunities).to.be.an('array').with.length(3);
  });

  it('creates a new opportunity', async () => {
    const data = {
      siteId,
      auditId: uuid(),
      title: 'New Opportunity',
      description: 'Description',
      runbook: 'https://example.com',
      type: 'broken-backlinks',
      origin: 'AI',
      status: 'NEW',
      guidance: { foo: 'bar' },
      data: { brokenLinks: ['https://example.com'] },
    };

    const opportunity = await Opportunity.create(data);

    expect(opportunity).to.be.an('object');

    expect(uuidValidate(opportunity.getId())).to.be.true;
    expect(isIsoDate(opportunity.getCreatedAt())).to.be.true;
    expect(isIsoDate(opportunity.getUpdatedAt())).to.be.true;

    const record = opportunity.toJSON();
    delete record.opportunityId;
    delete record.createdAt;
    delete record.updatedAt;
    expect(record).to.eql(data);
  });

  it('creates a new opportunity without auditId', async () => {
    const data = {
      siteId,
      title: 'New Opportunity',
      description: 'Description',
      runbook: 'https://example.com',
      type: 'broken-backlinks',
      origin: 'AI',
      status: 'NEW',
      guidance: { foo: 'bar' },
      data: { brokenLinks: ['https://example.com'] },
    };

    const opportunity = await Opportunity.create(data);

    expect(opportunity).to.be.an('object');

    expect(uuidValidate(opportunity.getId())).to.be.true;
    expect(isIsoDate(opportunity.getCreatedAt())).to.be.true;
    expect(isIsoDate(opportunity.getUpdatedAt())).to.be.true;

    const record = opportunity.toJSON();
    delete record.opportunityId;
    delete record.createdAt;
    delete record.updatedAt;
    expect(record).to.eql(data);

    expect(opportunity.getAuditId()).to.be.undefined;
    await expect(opportunity.getAudit()).to.eventually.be.equal(null);
  });

  it('removes an opportunity', async () => {
    const opportunity = await Opportunity.findById(sampleData.opportunities[0].getId());
    const suggestions = await opportunity.getSuggestions();

    expect(suggestions).to.be.an('array').with.length(3);

    await opportunity.remove();

    const notFound = await Opportunity.findById(sampleData.opportunities[0].getId());
    await expect(notFound).to.be.null;

    // make sure dependent suggestions are removed as well
    await Promise.all(suggestions.map(async (suggestion) => {
      const notFoundSuggestion = await Suggestion.findById(suggestion.getId());
      await expect(notFoundSuggestion).to.be.null;
    }));
  });

  it('throws when removing a dependent fails', async () => { /* eslint-disable no-underscore-dangle */
    const opportunity = await Opportunity.findById(sampleData.opportunities[1].getId());
    const suggestions = await opportunity.getSuggestions();

    expect(suggestions).to.be.an('array').with.length(3);

    // make one suggestion fail to remove
    suggestions[0]._remove = sinon.stub().rejects(new Error('Failed to remove suggestion'));

    opportunity.getSuggestions = sinon.stub().resolves(suggestions);

    await expect(opportunity.remove()).to.be.rejectedWith(`Failed to remove entity opportunity with ID ${opportunity.getId()}`);
    expect(suggestions[0]._remove).to.have.been.calledOnce;
    expect(mockLogger.error).to.have.been.calledWith(`Failed to remove dependent entity suggestion with ID ${suggestions[0].getId()}`);

    // make sure the opportunity is still there
    const stillThere = await Opportunity.findById(sampleData.opportunities[1].getId());
    expect(stillThere).to.be.an('object');

    // make sure the other suggestions are removed
    const remainingSuggestions = await Suggestion.allByOpportunityId(opportunity.getId());
    expect(remainingSuggestions).to.be.an('array').with.length(1);
    expect(remainingSuggestions[0].getId()).to.equal(suggestions[0].getId());
  });

  it('creates many opportunities', async () => {
    const data = [
      {
        siteId,
        auditId: uuid(),
        title: 'New Opportunity 1',
        description: 'Description',
        runbook: 'https://example.com',
        type: 'broken-backlinks',
        origin: 'AI',
        status: 'NEW',
        data: { brokenLinks: ['https://example.com'] },
      },
      {
        siteId,
        auditId: uuid(),
        title: 'New Opportunity 2',
        description: 'Description',
        runbook: 'https://example.com',
        type: 'broken-internal-links',
        origin: 'AI',
        status: 'NEW',
        data: { brokenInternalLinks: ['https://example.com'] },
      },
    ];

    const opportunities = await Opportunity.createMany(data);

    expect(opportunities).to.be.an('object');
    expect(opportunities.createdItems).to.be.an('array').with.length(2);
    expect(opportunities.errorItems).to.be.an('array').with.length(0);

    opportunities.createdItems.forEach((opportunity, index) => {
      expect(opportunity).to.be.an('object');

      expect(uuidValidate(opportunity.getId())).to.be.true;
      expect(isIsoDate(opportunity.getCreatedAt())).to.be.true;
      expect(isIsoDate(opportunity.getUpdatedAt())).to.be.true;

      expect(
        sanitizeIdAndAuditFields('Opportunity', opportunity.toJSON()),
      ).to.eql(
        sanitizeTimestamps(data[index]),
      );
    });
  });

  it('fails to create many opportunities with invalid data', async () => {
    const data = [
      {
        siteId,
        auditId: uuid(),
        title: 'New Opportunity 1',
        description: 'Description',
        runbook: 'https://example.com',
        type: 'broken-backlinks',
        origin: 'AI',
        status: 'NEW',
        data: { brokenLinks: ['https://example.com'] },
      },
      {
        siteId,
        auditId: uuid(),
        title: 'New Opportunity 2',
        description: 'Description',
        runbook: 'https://example.com',
        type: 'broken-internal-links',
        origin: 'AI',
        status: 'NEW',
        data: { brokenInternalLinks: ['https://example.com'] },
      },
      {
        siteId,
        auditId: uuid(),
        title: 'New Opportunity 3',
        description: 'Description',
        runbook: 'https://example.com',
        type: 'broken-internal-links',
        origin: 'AI',
        status: 'NEW',
        data: { brokenInternalLinks: ['https://example.com'] },
      },
    ];

    data[2].title = null;

    const result = await Opportunity.createMany(data);

    expect(result).to.be.an('object');
    expect(result).to.have.property('createdItems');
    expect(result).to.have.property('errorItems');

    expect(result.createdItems).to.be.an('array').with.length(2);
    expect(result.errorItems).to.be.an('array').with.length(1);
    expect(result.errorItems[0].item).to.eql(data[2]);
    expect(result.errorItems[0].error).to.be.an.instanceOf(ValidationError);

    const [opportunity1, opportunity2] = result.createdItems;

    const record1 = opportunity1.toJSON();
    delete record1.opportunityId;
    delete record1.createdAt;
    delete record1.updatedAt;

    const record2 = opportunity2.toJSON();
    delete record2.opportunityId;
    delete record2.createdAt;
    delete record2.updatedAt;

    expect(record1).to.eql(data[0]);
    expect(record2).to.eql(data[1]);
  });
});
