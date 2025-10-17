/*
 * Copyright 2023 Adobe. All rights reserved.
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
/* eslint-disable no-param-reassign */
/* eslint-disable no-use-before-define */

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import EntityRegistry from '@adobe/spacecat-shared-data-access/src/models/base/entity.registry.js';
// eslint-disable-next-line import/no-extraneous-dependencies -- snatched from shared-data-access
import * as electrodb from 'electrodb';
import * as crypto from 'crypto';

import { FixEntity, Suggestion } from '@adobe/spacecat-shared-data-access';
import AccessControlUtil from '../../src/support/access-control-util.js';
import { FixesController } from '../../src/controllers/fixes.js';
import { FixDto } from '../../src/dto/fix.js';
import { SuggestionDto } from '../../src/dto/suggestion.js';

use(chaiAsPromised);
use(sinonChai);

/**
 * @import type {
 *   FixEntityCollection,
 *   SuggestionCollection
 * } from '@adobe/spacecat-shared-data-access'
 *
 * @import type { RequestContext } from '../../src/controllers/fixes.js'
 */

describe('Fixes Controller', () => {
  // This must not be mocked, because index creation on the schema relies on side effects.
  // electrodb.Service() extends index definitions with `facets` properties.
  // Index accessor creation on collections relies on the presence of `facets`.
  const electroService = new electrodb.Service(EntityRegistry.getEntities());

  const sandbox = sinon.createSandbox();
  /** @type {AccessControlUtil} */
  let accessControlUtil;
  /** @type {FixesController} */
  let fixesController;
  /** @type {FixEntityCollection} */
  let fixEntityCollection;
  /** @type {FixEntitySuggestionCollection} */
  let fixEntitySuggestionCollection;
  /** @type {SuggestionCollection} */
  let suggestionCollection;
  /** @type {RequestContext} */
  let requestContext;
  let opportunityGetStub;

  const siteId = '86ef4aae-7296-417d-9658-8cd4c7edc374';
  const opportunityId = 'a3d2f1e9-5f4c-4e6b-8c7d-0c7b5a2f1a2f';

  const log = { ...console, debug: () => undefined, info: () => undefined };

  beforeEach(() => {
    const { fixEntity, opportunity, suggestion } = electroService.entities;
    sandbox.stub(fixEntity, 'create').callsFake(fakeCreateFix);
    sandbox.stub(fixEntity, 'upsert').callsFake(fakeCreateFix);
    sandbox.stub(suggestion, 'create').callsFake(fakeCreateSuggestion);
    sandbox.stub(suggestion, 'upsert').callsFake(fakeCreateSuggestion);
    opportunityGetStub = sandbox.stub(opportunity, 'get')
      .withArgs({ opportunityId })
      .callsFake((data) => ({ go: async () => ({ data: { ...data, siteId } }) }));

    const entityRegistry = new EntityRegistry(electroService, log);
    const dataAccess = entityRegistry.getCollections();
    fixEntityCollection = dataAccess.FixEntity;
    suggestionCollection = dataAccess.Suggestion;
    fixEntitySuggestionCollection = dataAccess.FixEntitySuggestion;
    sandbox.stub(fixEntityCollection, 'allByOpportunityId');
    sandbox.stub(fixEntityCollection, 'allByOpportunityIdAndStatus');
    sandbox.stub(fixEntityCollection, 'findById');
    sandbox.stub(fixEntityCollection, 'setSuggestionsForFixEntity');
    sandbox.stub(fixEntityCollection, 'getAllFixesWithSuggestionByCreatedAt');
    sandbox.stub(suggestionCollection, 'allByIndexKeys');
    sandbox.stub(suggestionCollection, 'findById');
    sandbox.stub(fixEntitySuggestionCollection, 'createMany');
    sandbox.stub(fixEntitySuggestionCollection, 'allByIndexKeys');
    sandbox.stub(fixEntitySuggestionCollection, 'removeByIndexKeys');
    sandbox.stub(fixEntitySuggestionCollection, 'allByFixEntityId');
    sandbox.stub(fixEntitySuggestionCollection, 'allBySuggestionId');
    sandbox.stub(suggestionCollection, 'batchGetByKeys');
    sandbox.stub(dataAccess.Site.entity, 'get').returns({
      go: async () => ({ data: { siteId } }),
    });

    accessControlUtil = sandbox.createStubInstance(AccessControlUtil);
    accessControlUtil.hasAccess.resolves(true);
    fixesController = new FixesController({ dataAccess }, accessControlUtil);
    requestContext = {
      params: { siteId, opportunityId },
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('Fixes for an opportunity', () => {
    it('responds 403 if the request does not have authorization/access', async () => {
      accessControlUtil.hasAccess.resolves(false);
      const response = await fixesController.getAllForOpportunity(requestContext);
      expect(response).includes({ status: 403 });
      expect(await response.json()).deep.equals({
        message: 'Only users belonging to the organization may access fix entities.',
      });
    });

    it('can get all fixes for an opportunity', async () => {
      const fixEntities = await Promise.all([
        fixEntityCollection.create({
          type: Suggestion.TYPES.CONTENT_UPDATE,
          opportunityId,
          changeDetails: { arbitrary: 'value 1' },
        }),
        fixEntityCollection.create({
          type: Suggestion.TYPES.REDIRECT_UPDATE,
          opportunityId,
          changeDetails: { arbitrary: 'value 2' },
        }),
        fixEntityCollection.create({
          type: Suggestion.TYPES.METADATA_UPDATE,
          opportunityId,
          changeDetails: { arbitrary: 'value 3' },
        }),
      ]);
      fixEntityCollection.allByOpportunityId.resolves(fixEntities);

      const response = await fixesController.getAllForOpportunity(requestContext);

      expect(response).includes({ status: 200 });
      expect(await response.json()).deep.equals(fixEntities.map(FixDto.toJSON));
    });

    it('responds 404 if the fix does not belong to the given opportunity', async () => {
      fixEntityCollection.allByOpportunityId.resolves([
        await fixEntityCollection.create({
          type: Suggestion.TYPES.CONTENT_UPDATE,
          opportunityId: 'wrong-opportunity-id',
        }),
      ]);

      const response = await fixesController.getAllForOpportunity(requestContext);
      expect(response).includes({ status: 404 });
      expect(await response.json()).deep.equals({
        message: 'Opportunity not found',
      });
    });

    it('responds 404 if the opportunity does not belong to the given site', async () => {
      fixEntityCollection.allByOpportunityId.resolves([]);
      opportunityGetStub.callsFake((data) => ({
        go: async () => ({ data: { ...data, siteId: 'wrong-site-id' } }),
      }));

      const response = await fixesController.getAllForOpportunity(requestContext);
      expect(response).includes({ status: 404 });
      expect(await response.json()).deep.equals({
        message: 'Opportunity not found',
      });
    });

    it('responds 400 if the site ID parameter is not a uuid', async () => {
      requestContext.params.siteId = 'not-a-uuid';
      const response = await fixesController.getAllForOpportunity(requestContext);
      expect(response).includes({ status: 400 });
    });

    it('responds 400 if the opportunity ID parameter is not a uuid', async () => {
      requestContext.params.opportunityId = 'not-a-uuid';
      const response = await fixesController.getAllForOpportunity(requestContext);
      expect(response).includes({ status: 400 });
    });

    describe('with fixEntityCreatedDate parameter', () => {
      const fixEntityCreatedDate = '2025-05-19T01:23:45.678Z';

      beforeEach(() => {
        requestContext.data = { fixCreatedDate: fixEntityCreatedDate };
      });

      it('can get all fixes with suggestions by created date', async () => {
        const suggestion1 = await suggestionCollection.create({
          opportunityId,
          type: Suggestion.TYPES.CONTENT_UPDATE,
        });
        const suggestion2 = await suggestionCollection.create({
          opportunityId,
          type: Suggestion.TYPES.REDIRECT_UPDATE,
        });

        const fixEntity = await fixEntityCollection.create({
          type: Suggestion.TYPES.CONTENT_UPDATE,
          opportunityId,
          changeDetails: { arbitrary: 'value 1' },
          createdAt: fixEntityCreatedDate,
        });

        fixEntityCollection.getAllFixesWithSuggestionByCreatedAt
          .withArgs(opportunityId, fixEntityCreatedDate)
          .resolves([
            {
              fixEntity,
              suggestions: [suggestion1, suggestion2],
            },
          ]);

        const response = await fixesController.getAllForOpportunity(requestContext);

        expect(response).includes({ status: 200 });
        const result = await response.json();
        expect(result).to.have.lengthOf(1);
        expect(result[0]).to.include({
          id: fixEntity.getId(),
          opportunityId,
          type: Suggestion.TYPES.CONTENT_UPDATE,
        });
        expect(result[0].suggestions).to.have.lengthOf(2);
        expect(result[0].suggestions[0].id).to.equal(suggestion1.getId());
        expect(result[0].suggestions[1].id).to.equal(suggestion2.getId());
      });

      it('returns empty array when no fixes found for the given created date', async () => {
        fixEntityCollection.getAllFixesWithSuggestionByCreatedAt
          .withArgs(opportunityId, fixEntityCreatedDate)
          .resolves([]);

        const response = await fixesController.getAllForOpportunity(requestContext);

        expect(response).includes({ status: 200 });
        const result = await response.json();
        expect(result).to.deep.equal([]);
      });

      it('responds 404 if the fix does not belong to the given opportunity', async () => {
        const fixEntity = await fixEntityCollection.create({
          type: Suggestion.TYPES.CONTENT_UPDATE,
          opportunityId: 'wrong-opportunity-id',
          createdAt: fixEntityCreatedDate,
        });

        fixEntityCollection.getAllFixesWithSuggestionByCreatedAt
          .withArgs(opportunityId, fixEntityCreatedDate)
          .resolves([
            {
              fixEntity,
              suggestions: [],
            },
          ]);

        const response = await fixesController.getAllForOpportunity(requestContext);
        expect(response).includes({ status: 404 });
        expect(await response.json()).deep.equals({
          message: 'Opportunity not found',
        });
      });

      it('responds 404 if the opportunity does not belong to the given site', async () => {
        const fixEntity = await fixEntityCollection.create({
          type: Suggestion.TYPES.CONTENT_UPDATE,
          opportunityId,
          createdAt: fixEntityCreatedDate,
        });

        fixEntityCollection.getAllFixesWithSuggestionByCreatedAt
          .withArgs(opportunityId, fixEntityCreatedDate)
          .resolves([
            {
              fixEntity,
              suggestions: [],
            },
          ]);

        opportunityGetStub.callsFake((data) => ({
          go: async () => ({ data: { ...data, siteId: 'wrong-site-id' } }),
        }));

        const response = await fixesController.getAllForOpportunity(requestContext);
        expect(response).includes({ status: 404 });
        expect(await response.json()).deep.equals({
          message: 'Opportunity not found',
        });
      });

      it('can get multiple fixes with their suggestions by created date', async () => {
        const suggestion1 = await suggestionCollection.create({
          opportunityId,
          type: Suggestion.TYPES.CONTENT_UPDATE,
        });
        const suggestion2 = await suggestionCollection.create({
          opportunityId,
          type: Suggestion.TYPES.REDIRECT_UPDATE,
        });
        const suggestion3 = await suggestionCollection.create({
          opportunityId,
          type: Suggestion.TYPES.METADATA_UPDATE,
        });

        const fixEntity1 = await fixEntityCollection.create({
          type: Suggestion.TYPES.CONTENT_UPDATE,
          opportunityId,
          changeDetails: { arbitrary: 'value 1' },
          createdAt: fixEntityCreatedDate,
        });

        const fixEntity2 = await fixEntityCollection.create({
          type: Suggestion.TYPES.REDIRECT_UPDATE,
          opportunityId,
          changeDetails: { arbitrary: 'value 2' },
          createdAt: fixEntityCreatedDate,
        });

        fixEntityCollection.getAllFixesWithSuggestionByCreatedAt
          .withArgs(opportunityId, fixEntityCreatedDate)
          .resolves([
            {
              fixEntity: fixEntity1,
              suggestions: [suggestion1, suggestion2],
            },
            {
              fixEntity: fixEntity2,
              suggestions: [suggestion3],
            },
          ]);

        const response = await fixesController.getAllForOpportunity(requestContext);

        expect(response).includes({ status: 200 });
        const result = await response.json();
        expect(result).to.have.lengthOf(2);

        expect(result[0]).to.include({
          id: fixEntity1.getId(),
          opportunityId,
          type: Suggestion.TYPES.CONTENT_UPDATE,
        });
        expect(result[0].suggestions).to.have.lengthOf(2);

        expect(result[1]).to.include({
          id: fixEntity2.getId(),
          opportunityId,
          type: Suggestion.TYPES.REDIRECT_UPDATE,
        });
        expect(result[1].suggestions).to.have.lengthOf(1);
      });

      it('handles fixes with no suggestions when querying by created date', async () => {
        const fixEntity = await fixEntityCollection.create({
          type: Suggestion.TYPES.CONTENT_UPDATE,
          opportunityId,
          changeDetails: { arbitrary: 'value 1' },
          createdAt: fixEntityCreatedDate,
        });

        fixEntityCollection.getAllFixesWithSuggestionByCreatedAt
          .withArgs(opportunityId, fixEntityCreatedDate)
          .resolves([
            {
              fixEntity,
              suggestions: [],
            },
          ]);

        const response = await fixesController.getAllForOpportunity(requestContext);

        expect(response).includes({ status: 200 });
        const result = await response.json();
        expect(result).to.have.lengthOf(1);
        expect(result[0]).to.include({
          id: fixEntity.getId(),
          opportunityId,
          type: Suggestion.TYPES.CONTENT_UPDATE,
        });
        expect(result[0].suggestions).to.have.lengthOf(0);
      });
    });
  });

  describe('getting fixes by status', () => {
    beforeEach(() => {
      requestContext.params.status = 'PENDING';
    });

    it('responds 403 if the request does not have authorization/access', async () => {
      accessControlUtil.hasAccess.resolves(false);
      const response = await fixesController.getByStatus(requestContext);
      expect(response).includes({ status: 403 });
      expect(await response.json()).deep.equals({
        message: 'Only users belonging to the organization may access fix entities.',
      });
    });

    it('can get all fixes for an opportunity by status', async () => {
      const fixes = await Promise.all([
        fixEntityCollection.create({
          type: Suggestion.TYPES.CONTENT_UPDATE,
          opportunityId,
          changeDetails: { arbitrary: 'value 1' },
          status: 'PENDING',
        }),
        fixEntityCollection.create({
          type: Suggestion.TYPES.REDIRECT_UPDATE,
          opportunityId,
          changeDetails: { arbitrary: 'value 2' },
          status: 'PENDING',
        }),
      ]);
      fixEntityCollection.allByOpportunityIdAndStatus
        .withArgs(opportunityId, 'PENDING')
        .resolves(fixes);

      const response = await fixesController.getByStatus(requestContext);
      expect(response).includes({ status: 200 });
      expect(await response.json()).deep.equals(fixes.map(FixDto.toJSON));
    });

    it('responds 404 if the fix does not belong to the given opportunity', async () => {
      fixEntityCollection.allByOpportunityIdAndStatus.resolves([
        await fixEntityCollection.create({
          type: Suggestion.TYPES.CONTENT_UPDATE,
          opportunityId: 'wrong-opportunity-id',
          status: 'PENDING',
        }),
      ]);

      const response = await fixesController.getByStatus(requestContext);
      expect(response).includes({ status: 404 });
      expect(await response.json()).deep.equals({
        message: 'Opportunity not found',
      });
    });

    it('responds 404 if the opportunity does not belong to the given site', async () => {
      fixEntityCollection.allByOpportunityIdAndStatus.resolves([]);
      opportunityGetStub.callsFake((data) => ({
        go: async () => ({ data: { ...data, siteId: 'wrong-site-id' } }),
      }));

      const response = await fixesController.getByStatus(requestContext);
      expect(response).includes({ status: 404 });
      expect(await response.json()).deep.equals({
        message: 'Opportunity not found',
      });
    });

    it('responds 400 if the site ID parameter is not a uuid', async () => {
      requestContext.params.siteId = 'not-a-uuid';
      const response = await fixesController.getByStatus(requestContext);
      expect(response).includes({ status: 400 });
    });

    it('responds 400 if the opportunity ID parameter is not a uuid', async () => {
      requestContext.params.opportunityId = 'not-a-uuid';
      const response = await fixesController.getByStatus(requestContext);
      expect(response).includes({ status: 400 });
    });

    it('responds 400 if the request does not provide a status', async () => {
      requestContext.params.status = '';
      const response = await fixesController.getByStatus(requestContext);
      expect(response).includes({ status: 400 });
    });
  });

  describe('get a fix by ID', () => {
    const fixId = 'a4a6055c-de4b-4552-bc0c-01fdb45b98d5';
    beforeEach(() => {
      requestContext.params.fixId = fixId;
    });

    it('responds 403 if the request does not have authorization/access', async () => {
      accessControlUtil.hasAccess.resolves(false);
      const response = await fixesController.getByID(requestContext);
      expect(response).includes({ status: 403 });
      expect(await response.json()).deep.equals({
        message: 'Only users belonging to the organization may access fix entities.',
      });
    });

    it('can get a fix by ID', async () => {
      const fix = await fixEntityCollection.create({
        fixEntityId: fixId,
        type: Suggestion.TYPES.CONTENT_UPDATE,
        opportunityId,
      });
      fixEntityCollection.findById
        .withArgs(fixId)
        .resolves(fix);

      const response = await fixesController.getByID(requestContext);
      expect(response).includes({ status: 200 });
      expect(await response.json()).deep.equals(FixDto.toJSON(fix));
    });

    it('responds 404 if the fix does not exist', async () => {
      fixEntityCollection.findById
        .withArgs(fixId)
        .resolves(null);

      const response = await fixesController.getByID(requestContext);
      expect(response).includes({ status: 404 });
      expect(await response.json()).deep.equals({ message: 'Fix not found' });
    });

    it('responds 404 if the fix does not belong to the given opportunity', async () => {
      fixEntityCollection.findById
        .withArgs(fixId)
        .resolves(
          await fixEntityCollection.create({
            fixEntityId: fixId,
            type: Suggestion.TYPES.CONTENT_UPDATE,
            opportunityId: 'wrong-opportunity-id',
          }),
        );

      const response = await fixesController.getByID(requestContext);
      expect(response).includes({ status: 404 });
      expect(await response.json()).deep.equals({ message: 'Opportunity not found' });
    });

    it('responds 404 if the opportunity does not belong to the given site', async () => {
      opportunityGetStub.callsFake((data) => ({
        go: async () => ({ data: { ...data, siteId: 'wrong-site-id' } }),
      }));

      const response = await fixesController.getByID(requestContext);
      expect(response).includes({ status: 404 });
      expect(await response.json()).deep.equals({ message: 'Fix not found' });
    });

    it('responds 400 if the site ID parameter is not a uuid', async () => {
      requestContext.params.siteId = 'not-a-uuid';
      const response = await fixesController.getByID(requestContext);
      expect(response).includes({ status: 400 });
    });

    it('responds 400 if the opportunity ID parameter is not a uuid', async () => {
      requestContext.params.opportunityId = 'not-a-uuid';
      const response = await fixesController.getByID(requestContext);
      expect(response).includes({ status: 400 });
    });

    it('responds 400 if the fix ID parameter is not a uuid', async () => {
      requestContext.params.fixId = 'not-a-uuid';
      const response = await fixesController.getByID(requestContext);
      expect(response).includes({ status: 400 });
    });
  });

  describe('get suggestions belonging to a fix', () => {
    const fixId = 'a4a6055c-de4b-4552-bc0c-01fdb45b98d5';
    beforeEach(async () => {
      requestContext.params.fixId = fixId;

      fixEntityCollection.findById
        .withArgs(fixId)
        .resolves(await fixEntityCollection.create({
          fixEntityId: fixId,
          type: Suggestion.TYPES.CONTENT_UPDATE,
          opportunityId,
        }));
    });

    it('responds 403 if the request does not have authorization/access', async () => {
      accessControlUtil.hasAccess.resolves(false);
      const response = await fixesController.getAllSuggestionsForFix(requestContext);
      expect(response).includes({ status: 403 });
      expect(await response.json()).deep.equals({
        message: 'Only users belonging to the organization may access fix entities.',
      });
    });

    it('can get all suggestions for a fix', async () => {
      const suggestions = await Promise.all([
        suggestionCollection.create({ opportunityId }),
        suggestionCollection.create({ opportunityId }),
      ]);
      suggestionCollection.batchGetByKeys.resolves({
        data: suggestions,
        unprocessed: [],
      });
      fixEntitySuggestionCollection.allByFixEntityId.resolves(suggestions.map((s) => ({
        getSuggestionId: () => s.getId(),
        getFixEntityId: () => fixId,
      })));
      const response = await fixesController.getAllSuggestionsForFix(requestContext);
      expect(response).includes({ status: 200 });
      expect(await response.json()).deep.equals(suggestions.map(SuggestionDto.toJSON));
    });

    it('responds 404 if the fix does not exist', async () => {
      fixEntityCollection.findById
        .withArgs(fixId)
        .resolves(null);

      const response = await fixesController.getAllSuggestionsForFix(requestContext);
      expect(response).includes({ status: 404 });
      expect(await response.json()).deep.equals({ message: 'Fix not found' });
    });

    it('responds 404 if the opportunity does not belong to the given site', async () => {
      opportunityGetStub.callsFake((data) => ({
        go: async () => ({ data: { ...data, siteId: 'wrong-site-id' } }),
      }));

      const response = await fixesController.getAllSuggestionsForFix(requestContext);
      expect(response).includes({ status: 404 });
      expect(await response.json()).deep.equals({ message: 'Opportunity not found' });
    });

    it('responds 400 if the site ID parameter is not a uuid', async () => {
      requestContext.params.siteId = 'not-a-uuid';
      const response = await fixesController.getAllSuggestionsForFix(requestContext);
      expect(response).includes({ status: 400 });
    });

    it('responds 400 if the opportunity ID parameter is not a uuid', async () => {
      requestContext.params.opportunityId = 'not-a-uuid';
      const response = await fixesController.getAllSuggestionsForFix(requestContext);
      expect(response).includes({ status: 400 });
    });
  });

  describe('create fixes', () => {
    async function createSuggestion(options) {
      options.opportunityId ??= opportunityId;
      options.status ??= 'PENDING';

      const suggestion = await suggestionCollection.create(options);
      suggestionCollection.findById
        .withArgs(suggestion.getId())
        .resolves(suggestion);

      return suggestion;
    }

    beforeEach(() => {
      requestContext.data = null;

      // Configure the setSuggestionsForFixEntity mock for create fixes tests
      fixEntityCollection.setSuggestionsForFixEntity.resolves({
        createdItems: [],
        errorItems: [],
        removedCount: 0,
      });
    });

    it('responds 403 if the request does not have authorization/access', async () => {
      accessControlUtil.hasAccess.resolves(false);
      const response = await fixesController.createFixes(requestContext);
      expect(response).includes({ status: 403 });
      expect(await response.json()).deep.equals({
        message: 'Only users belonging to the organization may access fix entities.',
      });
    });

    it('can create a single fix', async () => {
      const fixData = { type: 'CONTENT_UPDATE', opportunityId };
      requestContext.data = [fixData];

      const response = await fixesController.createFixes(requestContext);
      expect(response).includes({ status: 207 });

      const { fixes, metadata } = await response.json();
      expect(metadata).deep.equals({ total: 1, success: 1, failed: 0 });
      expect(fixes).have.lengthOf(1);
      expect(fixes[0]).includes({ index: 0, statusCode: 201 });
      expect(fixes[0].fix).includes(fixData);
    });

    it('reflects failures of creating a single fix', async () => {
      sandbox.stub(log, 'error'); // silence error logging
      electroService.entities.fixEntity.create
        .returns({ go: () => Promise.reject(new Error('Arbitrary Failure')) });
      requestContext.data = [{ type: 'CONTENT_UPDATE', opportunityId }];

      const response = await fixesController.createFixes(requestContext);
      expect(response).includes({ status: 207 });

      const { fixes, metadata } = await response.json();
      expect(fixes).have.lengthOf(1);
      expect(fixes[0]).deep.equals({ index: 0, message: 'Failed to create', statusCode: 500 });
      expect(metadata).deep.equals({ total: 1, success: 0, failed: 1 });
    });

    it('can create multiple fixes', async () => {
      const fixData = [
        { type: 'CONTENT_UPDATE', opportunityId },
        { type: 'REDIRECT_UPDATE', opportunityId },
        { type: 'METADATA_UPDATE', opportunityId },
      ];
      requestContext.data = fixData;

      const response = await fixesController.createFixes(requestContext);
      expect(response).includes({ status: 207 });

      const { fixes, metadata } = await response.json();
      expect(metadata).deep.equals({ total: 3, success: 3, failed: 0 });
      expect(fixes).have.lengthOf(3);
      for (const idx of [0, 1, 2]) {
        expect(fixes[idx]).includes({ index: idx, statusCode: 201 });
        expect(fixes[idx].fix).includes(fixData[idx]);
      }
    });

    it('reflects failures when creating multiple fixes', async () => {
      sandbox.stub(log, 'error'); // silence error logging
      const fixData = [
        { type: 'CONTENT_UPDATE', opportunityId },
        { type: 'REDIRECT_UPDATE', opportunityId },
        { type: 'CONTENT_UPDATE', opportunityId },
        { type: 'METADATA_UPDATE', opportunityId },
      ];
      requestContext.data = fixData;

      electroService.entities.fixEntity.create
        .withArgs(sinon.match({ type: 'CONTENT_UPDATE' }))
        .returns({ go: () => Promise.reject(new Error('Arbitrary Failure')) });

      const response = await fixesController.createFixes(requestContext);
      expect(response).includes({ status: 207 });

      const { fixes, metadata } = await response.json();
      expect(fixes).have.lengthOf(4);
      expect(metadata).deep.equals({ total: 4, success: 2, failed: 2 });

      for (const idx of [1, 3]) {
        expect(fixes[idx]).includes({ index: idx, statusCode: 201 });
        expect(fixes[idx].fix).includes(fixData[idx]);
      }
      for (const idx of [0, 2]) {
        expect(fixes[idx]).deep.equals({ index: idx, message: 'Failed to create', statusCode: 500 });
      }
    });

    it('responds 400 if the request body is not an array', async () => {
      requestContext.data = { type: 'CONTENT_UPDATE', opportunityId };
      const response = await fixesController.createFixes(requestContext);
      expect(response).includes({ status: 400 });
      expect(await response.json()).deep.equals({ message: 'Request body must be an array' });
    });

    it('responds 400 if there is no request body', async () => {
      requestContext.data = '';
      const response = await fixesController.createFixes(requestContext);
      expect(response).includes({ status: 400 });
      expect(await response.json()).deep.equals({ message: 'No updates provided' });
    });

    it('responds 404 if the opportunity does not belong to the given site', async () => {
      opportunityGetStub.callsFake((data) => ({
        go: async () => ({ data: { ...data, siteId: 'wrong-site-id' } }),
      }));

      const response = await fixesController.createFixes(requestContext);
      expect(response).includes({ status: 404 });
      expect(await response.json()).deep.equals({ message: 'Opportunity not found' });
    });

    it('responds 400 if the site ID parameter is not a uuid', async () => {
      requestContext.params.siteId = 'not-a-uuid';
      const response = await fixesController.createFixes(requestContext);
      expect(response).includes({ status: 400 });
      expect(await response.json()).deep.equals({ message: 'Site ID required' });
    });

    it('responds 400 if the opportunity ID parameter is not a uuid', async () => {
      requestContext.params.opportunityId = 'not-a-uuid';
      const response = await fixesController.createFixes(requestContext);
      expect(response).includes({ status: 400 });
      expect(await response.json()).deep.equals({ message: 'Opportunity ID required' });
    });

    it('can create a fix with suggestion IDs using many-to-many relationship', async () => {
      const suggestions = await Promise.all([
        createSuggestion({ type: 'CONTENT_UPDATE' }),
        createSuggestion({ type: 'REDIRECT_UPDATE' }),
      ]);

      const fixData = {
        type: 'CONTENT_UPDATE',
        opportunityId,
        suggestionIds: suggestions.map((s) => s.getId()),
      };
      requestContext.data = [fixData];

      // Configure the setSuggestionsForFixEntity method for this test
      fixEntityCollection.setSuggestionsForFixEntity.resolves({
        createdItems: suggestions.map((s) => ({
          getSuggestionId: () => s.getId(),
          getFixEntityId: () => 'mock-fix-id',
        })),
        errorItems: [],
        removedCount: 0,
      });

      const response = await fixesController.createFixes(requestContext);
      expect(response).includes({ status: 207 });

      const { fixes, metadata } = await response.json();
      expect(metadata).deep.equals({ total: 1, success: 1, failed: 0 });
      expect(fixes).have.lengthOf(1);
      expect(fixes[0]).includes({ index: 0, statusCode: 201 });
      expect(fixes[0].fix).includes({ type: 'CONTENT_UPDATE', opportunityId });

      // Verify that setSuggestionsForFixEntity was called
      expect(fixEntityCollection.setSuggestionsForFixEntity).to.have.been.calledOnce;
    });

    it('can create multiple fixes with different suggestion IDs', async () => {
      const suggestions1 = await Promise.all([
        createSuggestion({ type: 'CONTENT_UPDATE' }),
        createSuggestion({ type: 'REDIRECT_UPDATE' }),
      ]);

      const suggestions2 = await Promise.all([
        createSuggestion({ type: 'METADATA_UPDATE' }),
      ]);

      const fixData = [
        {
          type: 'CONTENT_UPDATE',
          opportunityId,
          suggestionIds: suggestions1.map((s) => s.getId()),
        },
        {
          type: 'REDIRECT_UPDATE',
          opportunityId,
          suggestionIds: suggestions2.map((s) => s.getId()),
        },
        {
          type: 'METADATA_UPDATE',
          opportunityId,
          // No suggestionIds for this one
        },
      ];
      requestContext.data = fixData;

      // Configure the setSuggestionsForFixEntity method for this test
      fixEntityCollection.setSuggestionsForFixEntity.resolves({
        createdItems: [],
        errorItems: [],
        removedCount: 0,
      });

      const response = await fixesController.createFixes(requestContext);
      expect(response).includes({ status: 207 });

      const { fixes, metadata } = await response.json();
      expect(metadata).deep.equals({ total: 3, success: 3, failed: 0 });
      expect(fixes).have.lengthOf(3);

      expect(fixEntityCollection.setSuggestionsForFixEntity).to.have.been.calledTwice;
    });

    it('handles invalid suggestion IDs during fix creation', async () => {
      const validSuggestion = await createSuggestion({ type: 'CONTENT_UPDATE' });
      const invalidSuggestionId = '15345195-62e6-494c-81b1-1d0da0b51d84';

      const fixData = {
        type: 'CONTENT_UPDATE',
        opportunityId,
        suggestionIds: [validSuggestion.getId(), invalidSuggestionId],
      };
      requestContext.data = [fixData];

      // Configure validation failure in setSuggestionsForFixEntity
      suggestionCollection.findById.withArgs(invalidSuggestionId).resolves(null);
      fixEntityCollection.setSuggestionsForFixEntity.rejects(new Error('Invalid suggestion IDs'));

      const response = await fixesController.createFixes(requestContext);
      expect(response).includes({ status: 207 });

      const { fixes, metadata } = await response.json();
      expect(metadata).deep.equals({ total: 1, success: 0, failed: 1 });
      expect(fixes).have.lengthOf(1);
      expect(fixes[0]).includes({ index: 0, statusCode: 500 });
      expect(fixes[0].message).to.include('Invalid suggestion IDs');
    });
  });

  describe('patch fix status', () => {
    async function createFix(fixEntityId, type = 'METADATA_UPDATE', opportunity = opportunityId) {
      const fix = await fixEntityCollection.create({
        fixEntityId,
        type,
        opportunityId: opportunity,
        status: 'PENDING',
      });
      fixEntityCollection.findById.withArgs(fixEntityId).resolves(fix);
      sandbox.stub(fix.patcher, 'save');
      fixEntityCollection.findById.withArgs(fixEntityId).resolves(fix);
      return fix;
    }

    it('responds 403 if the request does not have authorization/access', async () => {
      accessControlUtil.hasAccess.resolves(false);
      const response = await fixesController.patchFixesStatus(requestContext);
      expect(response).includes({ status: 403 });
      expect(await response.json()).deep.equals({
        message: 'Only users belonging to the organization may access fix entities.',
      });
    });

    it('can patch the status of one fix', async () => {
      const fixId = 'a4a6055c-de4b-4552-bc0c-01fdb45b98d5';
      const fix = await createFix(fixId);
      requestContext.data = [{ id: fixId, status: 'PUBLISHED' }];

      const response = await fixesController.patchFixesStatus(requestContext);
      expect(response).includes({ status: 207 });
      const { fixes, metadata } = await response.json();
      expect(metadata).deep.equals({ total: 1, success: 1, failed: 0 });
      expect(fixes).lengthOf(1);

      expect(fix.getStatus()).equals('PUBLISHED');
      expect(fixes[0]).deep.equals({
        index: 0,
        statusCode: 200,
        fix: { ...FixDto.toJSON(fix), status: 'PUBLISHED' },
        uuid: fixId,
      });

      expect(fix.patcher.save).calledOnce;
    });

    it('can patch the status of multiple fixes', async () => {
      const [fix1, fix2, fix3] = [
        'a4a6055c-de4b-4552-bc0c-01fdb45b98d5',
        '930f8070-508a-4d94-a46c-279d4de2adfb',
        'a9807173-8e8e-4e8c-96f7-0a22d9dc90b8',
      ];
      const fixes = Object.fromEntries(await Promise.all(
        [
          [fix1, 'CONTENT_UPDATE'],
          [fix2, 'REDIRECT_UPDATE'],
          [fix3, 'METADATA_UPDATE'],
        ].map(async ([fixId, type]) => [fixId, await createFix(fixId, type)]),
      ));

      requestContext.data = [
        { id: fix1, status: 'PUBLISHED' },
        { id: fix2, status: 'DEPLOYED' },
        { id: fix3, status: 'ROLLED_BACK' },
      ];

      const response = await fixesController.patchFixesStatus(requestContext);
      expect(response).includes({ status: 207 });
      const { fixes: responseFixes, metadata } = await response.json();
      expect(metadata).deep.equals({ total: 3, success: 3, failed: 0 });
      expect(responseFixes).lengthOf(3);
      expect(responseFixes[0]).deep.equals({
        index: 0,
        statusCode: 200,
        fix: { ...FixDto.toJSON(fixes[fix1]), status: 'PUBLISHED' },
        uuid: fix1,
      });
      expect(responseFixes[1]).deep.equals({
        index: 1,
        statusCode: 200,
        fix: { ...FixDto.toJSON(fixes[fix2]), status: 'DEPLOYED' },
        uuid: fix2,
      });
      expect(responseFixes[2]).deep.equals({
        index: 2,
        statusCode: 200,
        fix: { ...FixDto.toJSON(fixes[fix3]), status: 'ROLLED_BACK' },
        uuid: fix3,
      });
    });

    it('handles different failure modes per patch', async () => {
      const fix1 = 'a4a6055c-de4b-4552-bc0c-01fdb45b98d5';
      const fix2 = '930f8070-508a-4d94-a46c-279d4de2adfb';
      const fix3 = 'a9807173-8e8e-4e8c-96f7-0a22d9dc90b8';
      const fix4 = 'b4a6055c-de4b-4552-bc0c-01fdb45b98d5';
      const fix5 = 'b04a6c48-0eef-4702-a900-b1bc50c792cc';
      const fix6 = '9b655f98-110d-492c-9bc2-e5a4e578eb9c';
      const fix7 = 'd4c4a248-e0b6-4d13-809a-4a89082274ed';
      const differentOpportunityId = 'c4a6055c-de4b-4552-bc0c-01fdb45b98d5';
      opportunityGetStub
        .withArgs({ opportunityId: differentOpportunityId })
        .callsFake((data) => ({ go: async () => ({ data: { ...data, siteId } }) }));
      const fixes = Object.fromEntries(await Promise.all(
        [
          { id: fix1, type: 'CONTENT_UPDATE' },
          { id: fix2, type: 'REDIRECT_UPDATE', opportunity: differentOpportunityId },
          { id: fix3, type: 'METADATA_UPDATE' },
          { id: fix4, type: 'CODE_CHANGE' },
          { id: fix5, type: 'METADATA_UPDATE' },
          { id: fix6, type: 'CONTENT_UPDATE' },
          { id: fix7, type: 'REDIRECT_UPDATE' },
        ].map(async ({ id, type, opportunity }) => [id, await createFix(id, type, opportunity)]),
      ));
      fixEntityCollection.findById.withArgs(fix1).resolves(null);

      requestContext.data = [
        { id: fix1, status: 'PUBLISHED' },
        { id: fix2, status: 'DEPLOYED' },
        { id: fix3, status: '~~invalid~~' },
        { id: fix4, status: fixes[fix4].getStatus() },
        { id: '', status: 'PUBLISHED' },
        { id: fix6, status: 'PUBLISHED' },
        { id: fix7, status: '' },
      ];

      const response = await fixesController.patchFixesStatus(requestContext);
      expect(response).includes({ status: 207 });

      const { fixes: responseFixes, metadata } = await response.json();
      expect(metadata).deep.equals({ total: 7, success: 1, failed: 6 });
      expect(responseFixes).lengthOf(7);
      expect(responseFixes[0]).deep.equals({
        index: 0,
        statusCode: 404,
        message: 'Fix not found',
        uuid: fix1,
      });
      expect(responseFixes[1]).deep.equals({
        index: 1,
        statusCode: 404,
        message: 'Opportunity not found',
        uuid: fix2,
      });
      expect(responseFixes[2]).includes({
        index: 2,
        statusCode: 400,
        uuid: fix3,
      });
      expect(responseFixes[3]).deep.equal({
        index: 3,
        statusCode: 400,
        message: 'No updates provided',
        uuid: fix4,
      });
      expect(responseFixes[4]).deep.equal({
        index: 4,
        statusCode: 400,
        message: 'fix id is required',
        uuid: '',
      });
      expect(responseFixes[5]).deep.equal({
        index: 5,
        statusCode: 200,
        fix: { ...FixDto.toJSON(fixes[fix6]), status: 'PUBLISHED' },
        uuid: fix6,
      });
      expect(responseFixes[6]).deep.equal({
        index: 6,
        statusCode: 400,
        message: 'fix status is required',
        uuid: fix7,
      });
    });

    it('responds 400 if the request body is not an array', async () => {
      requestContext.data = { id: 'a4a6055c-de4b-4552-bc0c-01fdb45b98d5', status: 'PUBLISHED' };
      const response = await fixesController.patchFixesStatus(requestContext);
      expect(response).includes({ status: 400 });
      expect(await response.json()).deep.equals({ message: 'Request body must be an array of [{ id: <fix id>, status: <fix status> },...]' });
    });

    it('responds 400 if the request body is empty', async () => {
      requestContext.data = '';
      const response = await fixesController.patchFixesStatus(requestContext);
      expect(response).includes({ status: 400 });
      expect(await response.json()).deep.equals({ message: 'No updates provided' });
    });

    it('responds 400 if the site ID parameter is not a uuid', async () => {
      requestContext.params.siteId = 'not-a-uuid';
      const response = await fixesController.patchFixesStatus(requestContext);
      expect(response).includes({ status: 400 });
    });

    it('responds 400 if the opportunity ID parameter is not a uuid', async () => {
      requestContext.params.opportunityId = 'not-a-uuid';
      const response = await fixesController.patchFixesStatus(requestContext);
      expect(response).includes({ status: 400 });
    });
  });

  describe('Patching a fix', () => {
    /** type {Map<string, Set<Suggestion>>} */
    let suggestionsByFix;
    /** type {Map<string, string>} */
    let fixBySuggestion;

    const fixEntityId = 'a4a6055c-de4b-4552-bc0c-01fdb45b98d5';
    let fix;

    async function createSuggestion(options) {
      options.opportunityId ??= opportunityId;
      options.status ??= 'PENDING';

      const suggestion = await suggestionCollection.create(options);
      // No longer setting fixEntityId directly on suggestions

      suggestionCollection.findById
        .withArgs(suggestion.getId())
        .resolves(suggestion);
      sinon.stub(suggestion.patcher, 'save');

      return suggestion;
    }

    async function setSuggestionFix(suggestion, fixId = null) {
      const id = suggestion.getId();
      const previousFix = fixBySuggestion.get(id);
      if (previousFix) {
        fixBySuggestion.delete(id);
        suggestionsByFix.get(previousFix).delete(suggestion);
      }

      if (fixId) {
        const suggestionsForFix = suggestionsByFix.get(fixId);
        if (suggestionsForFix) {
          suggestionsForFix.add(suggestion);
        } else {
          suggestionsByFix.set(fixId, new Set([suggestion]));
        }
      }
    }

    beforeEach(async () => {
      suggestionsByFix = new Map();
      fixBySuggestion = new Map();
      suggestionCollection.allByIndexKeys.callsFake(
        async ({ fixEntityId: id }) => [...(suggestionsByFix.get(id) ?? [])],
      );

      // Configure the many-to-many relationship method mock
      fixEntityCollection.setSuggestionsForFixEntity.callsFake(
        async (opportunityIdParam, fixEntity, suggestions) => {
          const fixId = fixEntity.getId();
          const suggestionIds = suggestions.map((s) => s.getId());

          // Clear existing relationships for this fix
          suggestionsByFix.set(fixId, new Set());

          // Set new relationships
          for (const suggestionId of suggestionIds) {
            // eslint-disable-next-line no-await-in-loop
            const suggestion = await suggestionCollection.findById(suggestionId);
            if (suggestion) {
              setSuggestionFix(suggestion, fixId);
            }
          }

          return {
            createdItems: suggestionIds
              .map((id) => ({ getSuggestionId: () => id, getFixEntityId: () => fixId })),
            errorItems: [],
            removedCount: 0,
          };
        },
      );

      fix = await fixEntityCollection.create({
        fixEntityId,
        type: Suggestion.TYPES.CONTENT_UPDATE,
        opportunityId,
        status: 'PENDING',
      });
      sandbox.stub(fix.patcher, 'save');
      fixEntityCollection.findById.withArgs(fixEntityId).resolves(fix);
      requestContext.params.fixId = fixEntityId;
    });

    it('responds 403 if the request does not have authorization/access', async () => {
      accessControlUtil.hasAccess.resolves(false);
      const response = await fixesController.patchFix(requestContext);
      expect(response).includes({ status: 403 });
      expect(await response.json()).deep.equals({
        message: 'Only users belonging to the organization may access fix entities.',
      });
    });

    it('can patch a fix', async () => {
      const suggestions = await Promise.all([
        createSuggestion({ type: 'CONTENT_UPDATE' }),
        createSuggestion({ type: 'REDIRECT_UPDATE' }),
      ]);

      fixEntitySuggestionCollection.allByFixEntityId.resolves(suggestions.map((s) => ({
        getSuggestionId: () => s.getId(),
        getFixEntityId: () => fix.getId(),
      })));

      fixEntityCollection.setSuggestionsForFixEntity.resolves({
        createdItems: suggestions.map((s) => ({
          getSuggestionId: () => s.getId(),
          getFixEntityId: () => fix.getId(),
        })),
        errorItems: [],
        removedCount: 0,
      });

      suggestionCollection.batchGetByKeys.resolves({
        data: suggestions,
        unprocessed: [],
      });

      const executedAt = '2025-05-19T10:27:27.903Z';
      const publishedAt = '2025-05-19T11:27:27.903Z';
      const changeDetails = { arbitrary: 'Changes' };
      requestContext.data = {
        executedBy: 'me',
        executedAt,
        publishedAt,
        changeDetails,
        suggestionIds: suggestions.map((s) => s.getId()),
      };

      const response = await fixesController.patchFix(requestContext);
      expect(response).includes({ status: 200 });
      expect(await response.json()).deep.equals(FixDto.toJSON(fix));
      expect(fix.getExecutedBy()).equals('me');
      expect(fix.getExecutedAt()).equals(executedAt);
      expect(fix.getPublishedAt()).equals(publishedAt);
      expect(fix.getChangeDetails()).deep.equals(changeDetails);
      expect(new Set(await fix.getSuggestions())).deep.equals(new Set(suggestions));
    });

    it('can patch a fix origin field', async () => {
      const suggestions = await Promise.all([
        createSuggestion({ type: 'CONTENT_UPDATE' }),
        createSuggestion({ type: 'METADATA_UPDATE' }),
      ]);

      const newOrigin = FixEntity.ORIGINS.ASO;
      requestContext.data = {
        origin: newOrigin,
        suggestionIds: suggestions.map((s) => s.getId()),
      };

      const response = await fixesController.patchFix(requestContext);
      expect(response).includes({ status: 200 });
      const responseData = await response.json();
      expect(responseData).deep.equals(FixDto.toJSON(fix));
      expect(responseData.origin).to.equal(FixEntity.ORIGINS.ASO);
      expect(fix.getOrigin()).equals(newOrigin);
      expect(new Set(await fix.getSuggestions())).deep.equals(new Set(suggestions));
    });

    it('responds 404 if a suggestion does not exist', async () => {
      requestContext.data = {
        suggestionIds: ['15345195-62e6-494c-81b1-1d0da0b51d84'],
      };
      const response = await fixesController.patchFix(requestContext);
      expect(response).includes({ status: 400 });
      expect(await response.json()).deep.equals({
        message: 'Invalid suggestion IDs',
      });
    });

    it('responds 404 if a suggestion belongs to another opportunity', async () => {
      const suggestion = await createSuggestion({
        opportunityId: '15345195-62e6-494c-81b1-1d0da0b51d84',
      });
      requestContext.data = {
        suggestionIds: [suggestion.getId()],
      };

      const response = await fixesController.patchFix(requestContext);
      expect(response).includes({ status: 400 });
      expect(await response.json()).deep.equals({
        message: 'Invalid suggestion IDs',
      });
    });

    it('responds 404 if the fix does not exist', async () => {
      requestContext.params.fixId = 'abb6f435-d7c2-46bb-8665-cf1d5df1e9c4';
      const response = await fixesController.patchFix(requestContext);
      expect(response).includes({ status: 404 });
    });

    it('responds 500 for errors', async () => {
      fix.patcher.save.rejects(new Error('Arbitrary Failure'));
      sandbox.stub(log, 'error'); // silence error logging

      requestContext.data = { changeDetails: { arbitrary: 'Changes' } };
      const response = await fixesController.patchFix(requestContext);
      expect(response).includes({ status: 500 });
    });

    it('responds 400 if no updates where provided', async () => {
      requestContext.data = {};
      const response = await fixesController.patchFix(requestContext);
      expect(response).includes({ status: 400 });
    });

    it('responds 400 if the request contains no data', async () => {
      requestContext.data = null;
      const response = await fixesController.patchFix(requestContext);
      expect(response).includes({ status: 400 });
    });

    it('responds 400 if the site ID parameter is not a uuid', async () => {
      requestContext.params.siteId = 'not-a-uuid';
      const response = await fixesController.patchFix(requestContext);
      expect(response).includes({ status: 400 });
    });

    it('responds 400 if the opportunity ID parameter is not a uuid', async () => {
      requestContext.params.opportunityId = 'not-a-uuid';
      const response = await fixesController.patchFix(requestContext);
      expect(response).includes({ status: 400 });
    });

    it('responds 400 if the fix does not belong to the given opportunity', async () => {
      requestContext.params.opportunityId = 'abb6f435-d7c2-46bb-8665-cf1d5df1e9c4';
      const response = await fixesController.patchFix(requestContext);
      expect(response).includes({ status: 404 });
      expect(await response.json()).deep.equals({
        message: 'Opportunity not found',
      });
    });

    it('can patch a fix with empty suggestion IDs array', async () => {
      requestContext.data = {
        suggestionIds: [],
        changeDetails: { arbitrary: 'Changes' },
      };

      fixEntityCollection.setSuggestionsForFixEntity.resolves({
        createdItems: [],
        errorItems: [],
        removedCount: 0,
      });

      const response = await fixesController.patchFix(requestContext);
      expect(response).includes({ status: 200 });

      // Verify that setSuggestionsForFixEntity was called with empty array
      expect(fixEntityCollection.setSuggestionsForFixEntity)
        .to.have.been.calledWith(opportunityId, fix, []);
    });

    it('can patch a fix with only suggestion IDs (no other updates)', async () => {
      const suggestions = await Promise.all([
        createSuggestion({ type: 'CONTENT_UPDATE' }),
      ]);

      requestContext.data = {
        suggestionIds: suggestions.map((s) => s.getId()),
      };

      const response = await fixesController.patchFix(requestContext);
      expect(response).includes({ status: 200 });

      // Verify that setSuggestionsForFixEntity was called
      expect(fixEntityCollection.setSuggestionsForFixEntity).to.have.been.calledWith(
        opportunityId,
        fix,
        suggestions,
      );
    });

    it('handles setSuggestionsForFixEntity failure gracefully', async () => {
      const suggestions = await Promise.all([
        createSuggestion({ type: 'CONTENT_UPDATE' }),
      ]);

      // Configure setSuggestionsForFixEntity to throw an error
      fixEntityCollection.setSuggestionsForFixEntity.rejects(new Error('Database error'));
      sandbox.stub(log, 'error'); // silence error logging

      requestContext.data = {
        suggestionIds: suggestions.map((s) => s.getId()),
        changeDetails: { arbitrary: 'Changes' },
      };

      const response = await fixesController.patchFix(requestContext);
      expect(response).includes({ status: 500 });
      expect(await response.json()).deep.equals({
        message: 'Error updating fix',
      });
    });

    it('can patch a fix with mixed updates including suggestion IDs', async () => {
      const suggestions = await Promise.all([
        createSuggestion({ type: 'CONTENT_UPDATE' }),
        createSuggestion({ type: 'REDIRECT_UPDATE' }),
      ]);

      const executedAt = '2025-05-19T10:27:27.903Z';
      const changeDetails = { arbitrary: 'Changes' };

      requestContext.data = {
        executedBy: 'updated-user',
        executedAt,
        changeDetails,
        suggestionIds: suggestions.map((s) => s.getId()),
      };

      const response = await fixesController.patchFix(requestContext);
      expect(response).includes({ status: 200 });

      // Verify all updates were applied
      expect(fix.getExecutedBy()).equals('updated-user');
      expect(fix.getExecutedAt()).equals(executedAt);
      expect(fix.getChangeDetails()).deep.equals(changeDetails);

      // Verify that setSuggestionsForFixEntity was called
      expect(fixEntityCollection.setSuggestionsForFixEntity).to.have.been.calledWith(
        opportunityId,
        fix,
        suggestions,
      );
    });
  });

  describe('fix removal', () => {
    const fixEntityId = 'a4a6055c-de4b-4552-bc0c-01fdb45b98d5';
    let fix;
    let removeStub;

    beforeEach(async () => {
      fix = await fixEntityCollection.create({
        fixEntityId,
        type: Suggestion.TYPES.CONTENT_UPDATE,
        opportunityId,
        status: 'PENDING',
      });
      fixEntityCollection.findById
        .withArgs(fixEntityId)
        .resolves(fix);

      removeStub = sandbox.stub(electroService.entities.fixEntity, 'remove')
        .callsFake(() => ({ go: async () => null }));
    });

    it('responds 403 if the request does not have authorization/access', async () => {
      accessControlUtil.hasAccess.resolves(false);
      const response = await fixesController.removeFix(requestContext);
      expect(response).includes({ status: 403 });
      expect(await response.json()).deep.equals({
        message: 'Only users belonging to the organization may access fix entities.',
      });
    });

    it('can remove a fix', async () => {
      requestContext.params.fixId = fixEntityId;

      const response = await fixesController.removeFix(requestContext);
      expect(response).includes({ status: 204 });
      expect(electroService.entities.fixEntity.remove).calledOnceWith({ fixEntityId });
    });

    it('responds 404 if the fix does not exist', async () => {
      requestContext.params.fixId = '09e6e14d-75db-4ab5-944d-12de6492a6e4';
      const response = await fixesController.removeFix(requestContext);
      expect(response).includes({ status: 404 });
      expect(await response.json()).deep.equals({ message: 'Fix not found' });
    });

    it('responds 400 if the site ID parameter is not a uuid', async () => {
      requestContext.params.siteId = 'not-a-uuid';
      const response = await fixesController.removeFix(requestContext);
      expect(response).includes({ status: 400 });
    });

    it('responds 400 if the opportunity ID parameter is not a uuid', async () => {
      requestContext.params.opportunityId = 'not-a-uuid';
      const response = await fixesController.removeFix(requestContext);
      expect(response).includes({ status: 400 });
    });

    it('responds 404 if the fix does not belong to the given opportunity', async () => {
      requestContext.params.fixId = fixEntityId;
      requestContext.params.opportunityId = '09e6e14d-75db-4ab5-944d-12de6492a6e4';

      const response = await fixesController.removeFix(requestContext);
      expect(response).includes({ status: 404 });
      expect(await response.json()).deep.equals({
        message: 'Opportunity not found',
      });
    });

    it('responds 500 if the fix cannot be removed', async () => {
      removeStub.throws(new Error('Arbitrary Failure'));
      requestContext.params.fixId = fixEntityId;
      sandbox.stub(log, 'error'); // silence the error log
      const response = await fixesController.removeFix(requestContext);
      expect(response).includes({ status: 500 });
      expect(await response.json()).deep.equals({
        message: 'Error removing fix: Failed to remove entity fixEntity with ID a4a6055c-de4b-4552-bc0c-01fdb45b98d5',
      });
    });
  });

  describe('FixDto', () => {
    it('serializes fix entity with origin field', async () => {
      const fixData = {
        type: Suggestion.TYPES.CONTENT_UPDATE,
        opportunityId,
        changeDetails: { arbitrary: 'test value' },
        origin: FixEntity.ORIGINS.ASO,
        status: FixEntity.STATUSES.DEPLOYED,
        executedBy: 'test-user',
        executedAt: '2025-05-19T01:23:45.678Z',
        publishedAt: '2025-05-19T02:23:45.678Z',
      };

      const fix = await fixEntityCollection.create(fixData);
      const serialized = FixDto.toJSON(fix);

      expect(serialized).to.include.keys([
        'id',
        'opportunityId',
        'type',
        'createdAt',
        'executedBy',
        'executedAt',
        'publishedAt',
        'changeDetails',
        'status',
        'origin',
      ]);

      expect(serialized.origin).to.equal(FixEntity.ORIGINS.ASO);
      expect(serialized.status).to.equal(FixEntity.STATUSES.DEPLOYED);
      expect(serialized.type).to.equal(Suggestion.TYPES.CONTENT_UPDATE);
      expect(serialized.opportunityId).to.equal(opportunityId);
      expect(serialized.changeDetails).to.deep.equal({ arbitrary: 'test value' });
      expect(serialized.executedBy).to.equal('test-user');
      expect(serialized.executedAt).to.equal('2025-05-19T01:23:45.678Z');
      expect(serialized.publishedAt).to.equal('2025-05-19T02:23:45.678Z');
    });

    it('serializes fix entity with default origin when not specified', async () => {
      const fixData = {
        type: Suggestion.TYPES.METADATA_UPDATE,
        opportunityId,
        changeDetails: { arbitrary: 'default test' },
      };

      const fix = await fixEntityCollection.create(fixData);
      const serialized = FixDto.toJSON(fix);

      expect(serialized.origin).to.equal(FixEntity.ORIGINS.SPACECAT);
      expect(serialized.status).to.equal(FixEntity.STATUSES.PENDING);
    });
  });
});

const ISO_DATE = '2025-05-19T01:23:45.678Z';
function fakeCreateFix(data) {
  data.fixEntityId ??= crypto.randomUUID();
  data.status ??= FixEntity.STATUSES.PENDING;
  data.origin ??= FixEntity.ORIGINS.SPACECAT;
  data.changeDetails ??= { arbitrary: 'details' };
  data.createdAt ??= ISO_DATE;
  data.executedAt ??= ISO_DATE;
  data.executedBy ??= 'test user';
  data.publishedAt ??= ISO_DATE;
  data.updatedAt ??= ISO_DATE;

  return { go: async () => ({ data }) };
}

function fakeCreateSuggestion(data) {
  if (data.opportunityId == null) {
    throw new TypeError('opportunityId is required');
  }

  data.createdAt ??= ISO_DATE;
  data.data ??= { arbitrary: 'suggestion' };
  data.kpiDeltas ??= { arbitrary: 'kpi' };
  data.rank ??= 123;
  data.status ??= Suggestion.STATUSES.NEW;
  data.suggestionId ??= crypto.randomUUID();
  data.type ??= 'METADATA_UPDATE';
  data.updatedAt ??= ISO_DATE;
  data.updatedBy ??= 'test user';

  return { go: async () => ({ data }) };
}
