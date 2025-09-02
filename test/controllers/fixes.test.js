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

// Add global fetch polyfill for tests
import { fetch } from '@adobe/fetch';

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import EntityRegistry from '@adobe/spacecat-shared-data-access/src/models/base/entity.registry.js';
// eslint-disable-next-line import/no-extraneous-dependencies -- snatched from shared-data-access
import * as electrodb from 'electrodb';
import * as crypto from 'crypto';

import {
  FixEntity, Suggestion,
} from '@adobe/spacecat-shared-data-access';
import AccessControlUtil from '../../src/support/access-control-util.js';
import { FixesController } from '../../src/controllers/fixes.js';
import { FixDto } from '../../src/dto/fix.js';
import { SuggestionDto } from '../../src/dto/suggestion.js';

// Make fetch available globally
global.fetch = fetch;

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
  /** @type {SuggestionCollection} */
  let suggestionCollection;
  /** @type {RequestContext} */
  let requestContext;
  let opportunityGetStub;
  let dataAccess;

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
    dataAccess = entityRegistry.getCollections();
    fixEntityCollection = dataAccess.FixEntity;
    suggestionCollection = dataAccess.Suggestion;
    sandbox.stub(fixEntityCollection, 'allByOpportunityId');
    sandbox.stub(fixEntityCollection, 'allByOpportunityIdAndStatus');
    sandbox.stub(fixEntityCollection, 'findById');
    sandbox.stub(suggestionCollection, 'allByIndexKeys');
    sandbox.stub(suggestionCollection, 'findById');
    sandbox.stub(dataAccess.Site.entity, 'get').returns({
      go: async () => ({ data: { siteId } }),
    });

    accessControlUtil = sandbox.createStubInstance(AccessControlUtil);
    accessControlUtil.hasAccess.resolves(true);
    fixesController = new FixesController({ dataAccess }, accessControlUtil);
    requestContext = {
      params: { siteId, opportunityId },
      log,
      env: {},
      imsClient: {
        getServiceAccessToken: sandbox.stub().resolves('test-service-token'),
      },
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
      suggestionCollection.allByIndexKeys
        .withArgs({ fixEntityId: fixId })
        .resolves(suggestions);

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
    beforeEach(() => {
      requestContext.data = null;
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
      setSuggestionFix(suggestion, suggestion.getFixEntityId());

      suggestionCollection.findById
        .withArgs(suggestion.getId())
        .resolves(suggestion);
      sinon.stub(suggestion.patcher, 'save').callsFake(() => {
        setSuggestionFix(suggestion, suggestion.getFixEntityId());
      });

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

  describe('applyAccessibilityFix', () => {
    let fetchStub;
    let mockSite;
    let mockOrganization;
    let mockOpportunity;
    let mockSuggestion1;
    let mockSuggestion2;
    let mockS3Client;

    beforeEach(() => {
      // Ensure fetch is available globally before stubbing
      if (!global.fetch) {
        global.fetch = fetch;
      }
      fetchStub = sandbox.stub(global, 'fetch');

      mockOrganization = {
        getImsOrgId: sandbox.stub().returns('test-ims-org-id'),
      };

      mockSite = {
        getOrganization: sandbox.stub().returns(Promise.resolve(mockOrganization)),
        getGitHubURL: sandbox.stub().returns('https://github.com/test/repo'),
      };

      mockOpportunity = {
        getSiteId: sandbox.stub().returns(siteId),
      };

      mockSuggestion1 = {
        getId: sandbox.stub().returns('550e8400-e29b-41d4-a716-446655440001'),
        getOpportunityId: sandbox.stub().returns(opportunityId),
        getData: sandbox.stub().returns({
          url: 'https://example.com/form',
          source: '#container form',
          issues: [
            {
              type: 'aria-allowed-attr',
              description: 'Elements must only use supported ARIA attributes',
              severity: 'critical',
            },
          ],
        }),
      };

      mockSuggestion2 = {
        getId: sandbox.stub().returns('550e8400-e29b-41d4-a716-446655440002'),
        getOpportunityId: sandbox.stub().returns(opportunityId),
        getData: sandbox.stub().returns({
          url: 'https://example.com/form',
          source: '#container form',
          issues: [
            {
              type: 'color-contrast',
              description: 'Elements must have sufficient color contrast',
              severity: 'serious',
            },
          ],
        }),
      };

      // Mock S3 client
      mockS3Client = {
        send: sandbox.stub(),
      };

      requestContext.s3 = {
        s3Client: mockS3Client,
      };

      // Mock IMS client
      requestContext.imsClient = {
        getServiceAccessToken: sandbox.stub().resolves('test-service-token'),
      };

      // Stub the dataAccess methods used by the controller
      sandbox.stub(dataAccess.Site, 'findById').resolves(mockSite);
      sandbox.stub(dataAccess.Opportunity, 'findById').resolves(mockOpportunity);
      suggestionCollection.findById.withArgs('550e8400-e29b-41d4-a716-446655440001').resolves(mockSuggestion1);
      suggestionCollection.findById.withArgs('550e8400-e29b-41d4-a716-446655440002').resolves(mockSuggestion2);

      // Ensure access control allows access
      accessControlUtil.hasAccess.resolves(true);
    });

    afterEach(() => {
      if (fetchStub && fetchStub.restore) {
        fetchStub.restore();
      }
    });

    it('successfully applies accessibility fix', async () => {
      requestContext.data = {
        suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
      };
      requestContext.env = {
        ASO_APP_URL: 'https://283250-asosampleapp-stage.adobeioruntime.net',
        S3_MYSTIQUE_BUCKET_NAME: 'spacecat-dev-mystique-assets',
        IMS_HOST: 'ims-na1.adobelogin.com',
        IMS_CLIENT_ID: 'test-client-id',
        IMS_CLIENT_SECRET: 'test-client-secret',
      };

      // Mock S3 responses
      const hashKey = 'c5d6f7e8a9b0c1d2'; // Hash of 'https://example.com/form_#container form'

      // Mock ListObjectsV2Command response
      mockS3Client.send.onFirstCall().resolves({
        Contents: [
          { Key: `fixes/${siteId}/${hashKey}/rule-123456789/report.json` },
          { Key: `fixes/${siteId}/${hashKey}/rule-123456789/assets/blocks/form/form.js` },
        ],
      });

      // Mock GetObjectCommand for report.json
      mockS3Client.send.onSecondCall().resolves({
        Body: {
          transformToString: async () => JSON.stringify({
            url: 'https://example.com/form',
            source: '#container form',
            type: 'aria-allowed-attr',
            updatedFiles: ['blocks/form/form.js'],
            htmlWithIssues: [],
            diff: '',
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
          }),
        },
      });

      // Mock GetObjectCommand for form.js file
      mockS3Client.send.onThirdCall().resolves({
        Body: {
          transformToString: async () => 'export function createForm() { /* fixed code */ }',
        },
      });

      fetchStub.resolves({
        ok: true,
        json: async () => ({ pullRequest: 'https://github.com/test/repo/pull/123' }),
      });

      const response = await fixesController.applyAccessibilityFix(requestContext);

      expect(response).includes({ status: 200 });
      expect(fetchStub).calledOnce;
      expect(requestContext.imsClient.getServiceAccessToken).calledOnce;

      const callArgs = fetchStub.firstCall.args;
      expect(callArgs[0]).equals('https://283250-asosampleapp-stage.adobeioruntime.net/api/v1/web/aem-sites-optimizer-gh-app/pull-request-handler');
      expect(callArgs[1].method).equals('POST');
      expect(callArgs[1].headers['x-gw-ims-org-id']).equals('test-ims-org-id');
      expect(callArgs[1].headers['Content-Type']).equals('application/json');
      expect(callArgs[1].headers.Authorization).equals('Bearer test-service-token');

      const body = JSON.parse(callArgs[1].body);
      expect(body.title).equals('Elements must only use supported ARIA attributes');
      expect(body.vcsType).equals('github');
      expect(body.repoURL).equals('https://github.com/test/repo');
      expect(body.updatedFiles).to.be.an('array').with.length(1);
      expect(body.updatedFiles[0].path).equals('blocks/form/form.js');
      expect(body.updatedFiles[0].content).equals('export function createForm() { /* fixed code */ }');

      const responseData = await response.json();
      expect(responseData.message).equals('Applied 1 accessibility fix(es) successfully');
      expect(responseData.successful).to.be.an('array').with.length(1);
      expect(responseData.successful[0].prUrl).equals('https://github.com/test/repo/pull/123');
      expect(responseData.successful[0].type).equals('aria-allowed-attr');
      expect(responseData.successful[0].appliedSuggestions).deep.equals(['550e8400-e29b-41d4-a716-446655440001']);
      expect(responseData.failed).to.be.an('array').with.length(0);
      expect(responseData.totalProcessed).equals(1);
    });

    it('responds 400 if request body is missing', async () => {
      requestContext.data = null;

      const response = await fixesController.applyAccessibilityFix(requestContext);
      expect(response).includes({ status: 400 });
      expect(await response.json()).deep.equals({ message: 'Request body is required' });
    });

    it('responds 400 if suggestionIds is missing', async () => {
      requestContext.data = {};

      const response = await fixesController.applyAccessibilityFix(requestContext);
      expect(response).includes({ status: 400 });
      expect(await response.json()).deep.equals({ message: 'suggestionIds array is required and must not be empty' });
    });

    it('responds 400 if suggestionIds is empty array', async () => {
      requestContext.data = {
        suggestionIds: [],
      };

      const response = await fixesController.applyAccessibilityFix(requestContext);
      expect(response).includes({ status: 400 });
      expect(await response.json()).deep.equals({ message: 'suggestionIds array is required and must not be empty' });
    });

    it('responds 400 if suggestionIds is not an array', async () => {
      requestContext.data = {
        suggestionIds: 'not-an-array',
      };

      const response = await fixesController.applyAccessibilityFix(requestContext);
      expect(response).includes({ status: 400 });
      expect(await response.json()).deep.equals({ message: 'suggestionIds array is required and must not be empty' });
    });

    it('responds 400 if suggestion ID is not a valid UUID', async () => {
      requestContext.data = {
        suggestionIds: ['not-a-valid-uuid'],
      };

      const response = await fixesController.applyAccessibilityFix(requestContext);
      expect(response).includes({ status: 400 });
      expect(await response.json()).deep.equals({ message: 'Invalid suggestion ID format: not-a-valid-uuid' });
    });

    it.skip('responds 500 if ASO_APP_URL is not configured and no default', async () => {
      requestContext.data = {
        suggestionIds: ['550e8400-e29b-41d4-a716-446655440000'],
      };
      requestContext.env = {
        ASO_APP_URL: '',
      };

      const response = await fixesController.applyAccessibilityFix(requestContext);
      expect(response).includes({ status: 500 });
      expect(await response.json()).deep.equals({ message: 'ASO app is not configured' });
    });

    it('responds 500 if S3 client is not available', async () => {
      requestContext.data = {
        suggestionIds: ['550e8400-e29b-41d4-a716-446655440000'],
      };
      requestContext.env = {
        ASO_APP_URL: 'https://test.app.url',
        S3_MYSTIQUE_BUCKET_NAME: 'test-bucket',
      };
      requestContext.s3 = null;

      const response = await fixesController.applyAccessibilityFix(requestContext);
      expect(response).includes({ status: 500 });
      expect(await response.json()).deep.equals({ message: 'S3 service is not configured' });
    });

    it('responds 404 if site is not found', async () => {
      requestContext.data = {
        suggestionIds: ['550e8400-e29b-41d4-a716-446655440000'],
      };
      requestContext.env = {
        ASO_APP_URL: 'https://test.app.url',
        S3_MYSTIQUE_BUCKET_NAME: 'test-bucket',
      };

      dataAccess.Site.findById.resolves(null);

      const response = await fixesController.applyAccessibilityFix(requestContext);
      expect(response).includes({ status: 404 });
      expect(await response.json()).deep.equals({ message: 'Site not found' });
    });

    it('responds 400 if site has no GitHub URL', async () => {
      requestContext.data = {
        suggestionIds: ['550e8400-e29b-41d4-a716-446655440000'],
      };
      requestContext.env = {
        ASO_APP_URL: 'https://test.app.url',
        S3_MYSTIQUE_BUCKET_NAME: 'test-bucket',
      };

      mockSite.getGitHubURL.returns('');

      const response = await fixesController.applyAccessibilityFix(requestContext);
      expect(response).includes({ status: 400 });
      expect(await response.json()).deep.equals({ message: 'Site must have a GitHub repository URL configured' });
    });

    it('responds 400 if organization has no IMS org ID', async () => {
      requestContext.data = {
        suggestionIds: ['550e8400-e29b-41d4-a716-446655440000'],
      };
      requestContext.env = {
        ASO_APP_URL: 'https://test.app.url',
        S3_MYSTIQUE_BUCKET_NAME: 'test-bucket',
      };

      mockOrganization.getImsOrgId.returns(null);

      const response = await fixesController.applyAccessibilityFix(requestContext);
      expect(response).includes({ status: 400 });
      expect(await response.json()).deep.equals({ message: 'Site must belong to an organization with IMS Org ID' });
    });

    it('responds 404 if suggestion is not found', async () => {
      requestContext.data = {
        suggestionIds: ['550e8400-e29b-41d4-a716-446655440000'],
      };
      requestContext.env = {
        ASO_APP_URL: 'https://test.app.url',
        S3_MYSTIQUE_BUCKET_NAME: 'test-bucket',
      };

      dataAccess.Suggestion.findById.withArgs('550e8400-e29b-41d4-a716-446655440000').resolves(null);

      const response = await fixesController.applyAccessibilityFix(requestContext);
      expect(response).includes({ status: 404 });
      expect(await response.json()).deep.equals({ message: 'Suggestion not found: 550e8400-e29b-41d4-a716-446655440000' });
    });

    it('responds 400 if suggestion does not belong to opportunity', async () => {
      requestContext.data = {
        suggestionIds: ['550e8400-e29b-41d4-a716-446655440000'],
      };
      requestContext.env = {
        ASO_APP_URL: 'https://test.app.url',
        S3_MYSTIQUE_BUCKET_NAME: 'test-bucket',
      };

      const mockWrongSuggestion = {
        getId: sandbox.stub().returns('550e8400-e29b-41d4-a716-446655440000'),
        getOpportunityId: sandbox.stub().returns('different-opportunity-id'),
      };

      dataAccess.Suggestion.findById.withArgs('550e8400-e29b-41d4-a716-446655440000').resolves(mockWrongSuggestion);

      const response = await fixesController.applyAccessibilityFix(requestContext);
      expect(response).includes({ status: 400 });
      expect(await response.json()).deep.equals({
        message: `Suggestion 550e8400-e29b-41d4-a716-446655440000 does not belong to opportunity ${opportunityId}`,
      });
    });

    it('responds 400 if no valid suggestions with URL and source found', async () => {
      requestContext.data = {
        suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
      };
      requestContext.env = {
        ASO_APP_URL: 'https://test.app.url',
        S3_MYSTIQUE_BUCKET_NAME: 'test-bucket',
      };

      // Mock suggestion with no URL/source
      mockSuggestion1.getData.returns({
        issues: [{ type: 'aria-allowed-attr' }],
      });

      const response = await fixesController.applyAccessibilityFix(requestContext);
      expect(response).includes({ status: 400 });
      expect(await response.json()).deep.equals({ message: 'No valid suggestions with URL and source found' });
    });

    it('responds 400 if no matching fixes found in S3', async () => {
      requestContext.data = {
        suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
      };
      requestContext.env = {
        ASO_APP_URL: 'https://test.app.url',
        S3_MYSTIQUE_BUCKET_NAME: 'test-bucket',
      };

      // Mock empty S3 response
      mockS3Client.send.resolves({ Contents: [] });

      const response = await fixesController.applyAccessibilityFix(requestContext);
      expect(response).includes({ status: 400 });
      expect(await response.json()).deep.equals({ message: 'No matching fixes found in S3 for the provided suggestions' });
    });

    it('responds 500 if IMS service token cannot be obtained', async () => {
      requestContext.data = {
        suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
      };
      requestContext.env = {
        ASO_APP_URL: 'https://test.app.url',
        S3_MYSTIQUE_BUCKET_NAME: 'test-bucket',
        IMS_HOST: 'ims-na1.adobelogin.com',
        IMS_CLIENT_ID: 'test-client-id',
        IMS_CLIENT_SECRET: 'test-client-secret',
      };

      // Setup S3 mocks for successful path
      const hashKey = 'c5d6f7e8a9b0c1d2';
      mockS3Client.send.onFirstCall().resolves({
        Contents: [
          { Key: `fixes/${siteId}/${hashKey}/rule-123456789/report.json` },
          { Key: `fixes/${siteId}/${hashKey}/rule-123456789/assets/blocks/form/form.js` },
        ],
      });
      mockS3Client.send.onSecondCall().resolves({
        Body: {
          transformToString: async () => JSON.stringify({
            type: 'aria-allowed-attr',
            updatedFiles: ['blocks/form/form.js'],
          }),
        },
      });
      mockS3Client.send.onThirdCall().resolves({
        Body: { transformToString: async () => 'file content' },
      });

      // Mock IMS client to fail
      requestContext.imsClient.getServiceAccessToken.resolves(null);

      const response = await fixesController.applyAccessibilityFix(requestContext);
      expect(response).includes({ status: 500 });
      expect(await response.json()).deep.equals({ message: 'Authentication failed' });
    });

    it('responds with partial success when ASO app request fails', async () => {
      requestContext.data = {
        suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
      };
      requestContext.env = {
        IMS_HOST: 'ims-na1.adobelogin.com',
        IMS_CLIENT_ID: 'test-client-id',
        IMS_CLIENT_SECRET: 'test-client-secret',
      };

      // Setup successful S3 mocks
      const hashKey = 'c5d6f7e8a9b0c1d2';
      mockS3Client.send.onFirstCall().resolves({
        Contents: [
          { Key: `fixes/${siteId}/${hashKey}/rule-123456789/report.json` },
          { Key: `fixes/${siteId}/${hashKey}/rule-123456789/assets/blocks/form/form.js` },
        ],
      });
      mockS3Client.send.onSecondCall().resolves({
        Body: {
          transformToString: async () => JSON.stringify({
            type: 'aria-allowed-attr',
            updatedFiles: ['blocks/form/form.js'],
          }),
        },
      });
      mockS3Client.send.onThirdCall().resolves({
        Body: { transformToString: async () => 'file content' },
      });

      fetchStub.resolves({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => 'ASO app error',
      });

      const response = await fixesController.applyAccessibilityFix(requestContext);
      expect(response).includes({ status: 200 });

      const responseData = await response.json();
      expect(responseData.message).equals('Applied 0 accessibility fix(es) successfully');
      expect(responseData.successful).to.be.an('array').with.length(0);
      expect(responseData.failed).to.be.an('array').with.length(1);
      expect(responseData.failed[0].success).equals(false);
      expect(responseData.failed[0].error).equals('AIO app returned 500: Internal Server Error');
      expect(responseData.totalProcessed).equals(1);
    });

    it('responds 500 if fetch throws an error', async () => {
      requestContext.data = {
        suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
      };
      requestContext.env = {
        ASO_APP_URL: 'https://test.app.url',
        S3_MYSTIQUE_BUCKET_NAME: 'test-bucket',
        IMS_HOST: 'ims-na1.adobelogin.com',
        IMS_CLIENT_ID: 'test-client-id',
        IMS_CLIENT_SECRET: 'test-client-secret',
      };

      // Setup successful S3 mocks
      const hashKey = 'c5d6f7e8a9b0c1d2';
      mockS3Client.send.onFirstCall().resolves({
        Contents: [
          { Key: `fixes/${siteId}/${hashKey}/rule-123456789/report.json` },
          { Key: `fixes/${siteId}/${hashKey}/rule-123456789/assets/blocks/form/form.js` },
        ],
      });
      mockS3Client.send.onSecondCall().resolves({
        Body: {
          transformToString: async () => JSON.stringify({
            type: 'aria-allowed-attr',
            updatedFiles: ['blocks/form/form.js'],
          }),
        },
      });
      mockS3Client.send.onThirdCall().resolves({
        Body: { transformToString: async () => 'file content' },
      });

      fetchStub.throws(new Error('Network error'));

      const response = await fixesController.applyAccessibilityFix(requestContext);
      expect(response).includes({ status: 500 });
      expect(await response.json()).deep.equals({ message: 'Failed to apply accessibility fix' });
    });

    it('handles multiple suggestions with same URL and source', async () => {
      requestContext.data = {
        suggestionIds: ['550e8400-e29b-41d4-a716-446655440001', '550e8400-e29b-41d4-a716-446655440002'],
      };
      requestContext.env = {
        ASO_APP_URL: 'https://test.app.url',
        S3_MYSTIQUE_BUCKET_NAME: 'test-bucket',
        IMS_HOST: 'ims-na1.adobelogin.com',
        IMS_CLIENT_ID: 'test-client-id',
        IMS_CLIENT_SECRET: 'test-client-secret',
      };

      // Both suggestions have same URL/source, so they'll be grouped together
      const hashKey = 'c5d6f7e8a9b0c1d2';
      mockS3Client.send.onFirstCall().resolves({
        Contents: [
          { Key: `fixes/${siteId}/${hashKey}/rule-123456789/report.json` },
          { Key: `fixes/${siteId}/${hashKey}/rule-123456789/assets/blocks/form/form.js` },
        ],
      });
      mockS3Client.send.onSecondCall().resolves({
        Body: {
          transformToString: async () => JSON.stringify({
            type: 'aria-allowed-attr',
            updatedFiles: ['blocks/form/form.js'],
          }),
        },
      });
      mockS3Client.send.onThirdCall().resolves({
        Body: { transformToString: async () => 'fixed form content' },
      });

      fetchStub.resolves({
        ok: true,
        json: async () => ({ prUrl: 'https://github.com/test/repo/pull/125' }),
      });

      const response = await fixesController.applyAccessibilityFix(requestContext);
      expect(response).includes({ status: 200 });

      const responseData = await response.json();
      expect(responseData.successful[0].appliedSuggestions).deep.equals(['550e8400-e29b-41d4-a716-446655440001']);
      expect(responseData.totalProcessed).equals(1); // Grouped into one fix
    });

    it('responds 400 if site ID parameter is not a uuid', async () => {
      requestContext.params.siteId = 'not-a-uuid';
      requestContext.data = {
        suggestionIds: ['550e8400-e29b-41d4-a716-446655440000'],
      };

      const response = await fixesController.applyAccessibilityFix(requestContext);
      expect(response).includes({ status: 400 });
    });

    it('responds 400 if opportunity ID parameter is not a uuid', async () => {
      requestContext.params.opportunityId = 'not-a-uuid';
      requestContext.data = {
        suggestionIds: ['550e8400-e29b-41d4-a716-446655440000'],
      };

      const response = await fixesController.applyAccessibilityFix(requestContext);
      expect(response).includes({ status: 400 });
    });

    it('responds 404 if opportunity not found', async () => {
      dataAccess.Opportunity.findById.resolves(null);

      requestContext.data = {
        suggestionIds: ['550e8400-e29b-41d4-a716-446655440000'],
      };

      const response = await fixesController.applyAccessibilityFix(requestContext);
      expect(response).includes({ status: 404 });
      expect(await response.json()).deep.equals({ message: 'Opportunity not found' });
    });

    it('responds 404 if opportunity belongs to different site', async () => {
      mockOpportunity.getSiteId.returns('different-site-id');

      requestContext.data = {
        suggestionIds: ['550e8400-e29b-41d4-a716-446655440000'],
      };

      const response = await fixesController.applyAccessibilityFix(requestContext);
      expect(response).includes({ status: 404 });
      expect(await response.json()).deep.equals({ message: 'Opportunity not found' });
    });

    it('skips suggestions with no matching report type', async () => {
      requestContext.data = {
        suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
      };
      requestContext.env = {
        ASO_APP_URL: 'https://test.app.url',
        S3_MYSTIQUE_BUCKET_NAME: 'test-bucket',
      };

      // Mock suggestion with different issue type than report
      mockSuggestion1.getData.returns({
        url: 'https://example.com/form',
        source: '#container form',
        issues: [{ type: 'different-type', description: 'Different issue' }],
      });

      const hashKey = 'c5d6f7e8a9b0c1d2';
      mockS3Client.send.onFirstCall().resolves({
        Contents: [{ Key: `fixes/${siteId}/${hashKey}/rule-123456789/report.json` }],
      });
      mockS3Client.send.onSecondCall().resolves({
        Body: {
          transformToString: async () => JSON.stringify({
            type: 'aria-allowed-attr', // Different from suggestion type
            updatedFiles: ['blocks/form/form.js'],
          }),
        },
      });

      const response = await fixesController.applyAccessibilityFix(requestContext);
      expect(response).includes({ status: 400 });
      expect(await response.json()).deep.equals({
        message: 'No matching fixes found in S3 for the provided suggestions',
      });
    });

    it('skips reports with no updated files', async () => {
      requestContext.data = {
        suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
      };
      requestContext.env = {
        ASO_APP_URL: 'https://test.app.url',
        S3_MYSTIQUE_BUCKET_NAME: 'test-bucket',
      };

      const hashKey = 'c5d6f7e8a9b0c1d2';
      mockS3Client.send.onFirstCall().resolves({
        Contents: [{ Key: `fixes/${siteId}/${hashKey}/rule-123456789/report.json` }],
      });
      mockS3Client.send.onSecondCall().resolves({
        Body: {
          transformToString: async () => JSON.stringify({
            type: 'aria-allowed-attr',
            updatedFiles: [], // No files to update
          }),
        },
      });

      const response = await fixesController.applyAccessibilityFix(requestContext);
      expect(response).includes({ status: 400 });
      expect(await response.json()).deep.equals({
        message: 'No matching fixes found in S3 for the provided suggestions',
      });
    });

    it('handles S3 read errors gracefully', async () => {
      requestContext.data = {
        suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
      };
      requestContext.env = {
        ASO_APP_URL: 'https://test.app.url',
        S3_MYSTIQUE_BUCKET_NAME: 'test-bucket',
      };

      const hashKey = 'c5d6f7e8a9b0c1d2';
      mockS3Client.send.onFirstCall().resolves({
        Contents: [{ Key: `fixes/${siteId}/${hashKey}/rule-123456789/report.json` }],
      });
      // Mock S3 read error for report.json
      mockS3Client.send.onSecondCall().rejects(new Error('S3 access denied'));

      const response = await fixesController.applyAccessibilityFix(requestContext);
      expect(response).includes({ status: 400 });
      expect(await response.json()).deep.equals({
        message: 'No matching fixes found in S3 for the provided suggestions',
      });
    });

    it('handles S3 list errors gracefully', async () => {
      requestContext.data = {
        suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
      };
      requestContext.env = {
        ASO_APP_URL: 'https://test.app.url',
        S3_MYSTIQUE_BUCKET_NAME: 'test-bucket',
      };

      // Mock S3 list error
      mockS3Client.send.onFirstCall().rejects(new Error('S3 list operation failed'));

      const response = await fixesController.applyAccessibilityFix(requestContext);
      expect(response).includes({ status: 400 });
      expect(await response.json()).deep.equals({
        message: 'No matching fixes found in S3 for the provided suggestions',
      });
    });

    it('handles S3 file read errors gracefully', async () => {
      requestContext.data = {
        suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
      };
      requestContext.env = {
        ASO_APP_URL: 'https://test.app.url',
        S3_MYSTIQUE_BUCKET_NAME: 'test-bucket',
      };

      const hashKey = 'c5d6f7e8a9b0c1d2';
      mockS3Client.send.onFirstCall().resolves({
        Contents: [
          { Key: `fixes/${siteId}/${hashKey}/rule-123456789/report.json` },
          { Key: `fixes/${siteId}/${hashKey}/rule-123456789/assets/blocks/form/form.js` },
        ],
      });
      mockS3Client.send.onSecondCall().resolves({
        Body: {
          transformToString: async () => JSON.stringify({
            type: 'aria-allowed-attr',
            updatedFiles: ['blocks/form/form.js'],
          }),
        },
      });
      // Mock S3 file read error for asset file
      mockS3Client.send.onThirdCall().rejects(new Error('File not accessible'));

      const response = await fixesController.applyAccessibilityFix(requestContext);
      expect(response).includes({ status: 400 });
      expect(await response.json()).deep.equals({
        message: 'No matching fixes found in S3 for the provided suggestions',
      });
    });

    it('handles IMS service token error when credentials are missing', async () => {
      requestContext.data = {
        suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
      };
      requestContext.env = {
        ASO_APP_URL: 'https://test.app.url',
        S3_MYSTIQUE_BUCKET_NAME: 'test-bucket',
        // Missing IMS credentials
      };

      // Setup successful S3 mocks
      const hashKey = 'c5d6f7e8a9b0c1d2';
      mockS3Client.send.onFirstCall().resolves({
        Contents: [
          { Key: `fixes/${siteId}/${hashKey}/rule-123456789/report.json` },
          { Key: `fixes/${siteId}/${hashKey}/rule-123456789/assets/blocks/form/form.js` },
        ],
      });
      mockS3Client.send.onSecondCall().resolves({
        Body: {
          transformToString: async () => JSON.stringify({
            type: 'aria-allowed-attr',
            updatedFiles: ['blocks/form/form.js'],
          }),
        },
      });
      mockS3Client.send.onThirdCall().resolves({
        Body: { transformToString: async () => 'file content' },
      });

      const response = await fixesController.applyAccessibilityFix(requestContext);
      expect(response).includes({ status: 500 });
      expect(await response.json()).deep.equals({ message: 'Authentication failed' });
    });

    it('handles IMS service token error when getServiceAccessToken throws', async () => {
      requestContext.data = {
        suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
      };
      requestContext.env = {
        ASO_APP_URL: 'https://test.app.url',
        S3_MYSTIQUE_BUCKET_NAME: 'test-bucket',
        IMS_HOST: 'ims-na1.adobelogin.com',
        IMS_CLIENT_ID: 'test-client-id',
        IMS_CLIENT_SECRET: 'test-client-secret',
      };

      // Setup successful S3 mocks
      const hashKey = 'c5d6f7e8a9b0c1d2';
      mockS3Client.send.onFirstCall().resolves({
        Contents: [
          { Key: `fixes/${siteId}/${hashKey}/rule-123456789/report.json` },
          { Key: `fixes/${siteId}/${hashKey}/rule-123456789/assets/blocks/form/form.js` },
        ],
      });
      mockS3Client.send.onSecondCall().resolves({
        Body: {
          transformToString: async () => JSON.stringify({
            type: 'aria-allowed-attr',
            updatedFiles: ['blocks/form/form.js'],
          }),
        },
      });
      mockS3Client.send.onThirdCall().resolves({
        Body: { transformToString: async () => 'file content' },
      });

      // Mock IMS client to throw error
      requestContext.imsClient.getServiceAccessToken.rejects(new Error('IMS service unavailable'));

      const response = await fixesController.applyAccessibilityFix(requestContext);
      expect(response).includes({ status: 500 });
      expect(await response.json()).deep.equals({ message: 'Authentication failed' });
    });

    it('handles suggestion with issue that has no description property', async () => {
      requestContext.data = {
        suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
      };
      requestContext.env = {
        ASO_APP_URL: 'https://test.app.url',
        S3_MYSTIQUE_BUCKET_NAME: 'test-bucket',
        IMS_HOST: 'ims-na1.adobelogin.com',
        IMS_CLIENT_ID: 'test-client-id',
        IMS_CLIENT_SECRET: 'test-client-secret',
      };

      // Mock suggestion with issue that has no description
      const mockSuggestionNoDesc = {
        getId: sandbox.stub().returns('550e8400-e29b-41d4-a716-446655440001'),
        getOpportunityId: sandbox.stub().returns(opportunityId),
        getData: sandbox.stub().returns({
          url: 'https://example.com/form',
          source: '#container form',
          issues: [
            {
              type: 'aria-allowed-attr',
              // No description property
              severity: 'critical',
            },
          ],
        }),
      };
      suggestionCollection.findById.withArgs('550e8400-e29b-41d4-a716-446655440001').resolves(mockSuggestionNoDesc);

      const hashKey = 'c5d6f7e8a9b0c1d2';
      mockS3Client.send.onFirstCall().resolves({
        Contents: [
          { Key: `fixes/${siteId}/${hashKey}/rule-123456789/report.json` },
          { Key: `fixes/${siteId}/${hashKey}/rule-123456789/assets/blocks/form/form.js` },
        ],
      });
      mockS3Client.send.onSecondCall().resolves({
        Body: {
          transformToString: async () => JSON.stringify({
            type: 'aria-allowed-attr',
            updatedFiles: ['blocks/form/form.js'],
          }),
        },
      });
      mockS3Client.send.onThirdCall().resolves({
        Body: { transformToString: async () => 'file content' },
      });

      fetchStub.resolves({
        ok: true,
        json: async () => ({ pullRequest: 'https://github.com/test/repo/pull/123' }),
      });

      const response = await fixesController.applyAccessibilityFix(requestContext);
      expect(response).includes({ status: 200 });

      // Verify the default description was used
      const callArgs = fetchStub.firstCall.args;
      const body = JSON.parse(callArgs[1].body);
      expect(body.title).equals('Fix aria-allowed-attr accessibility issue');
    });

    it('handles S3 ListObjects response with no Contents property', async () => {
      requestContext.data = {
        suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
      };
      requestContext.env = {
        ASO_APP_URL: 'https://test.app.url',
        S3_MYSTIQUE_BUCKET_NAME: 'test-bucket',
        IMS_HOST: 'ims-na1.adobelogin.com',
        IMS_CLIENT_ID: 'test-client-id',
        IMS_CLIENT_SECRET: 'test-client-secret',
      };

      // Mock S3 response with no Contents property
      mockS3Client.send.onFirstCall().resolves({
        // No Contents property
      });

      const response = await fixesController.applyAccessibilityFix(requestContext);
      expect(response).includes({ status: 400 });
      expect(await response.json()).deep.equals({
        message: 'No matching fixes found in S3 for the provided suggestions',
      });
    });

    it('handles IMS error without message property', async () => {
      requestContext.data = {
        suggestionIds: ['550e8400-e29b-41d4-a716-446655440001'],
      };
      requestContext.env = {
        ASO_APP_URL: 'https://test.app.url',
        S3_MYSTIQUE_BUCKET_NAME: 'test-bucket',
        IMS_HOST: 'ims-na1.adobelogin.com',
        IMS_CLIENT_ID: 'test-client-id',
        IMS_CLIENT_SECRET: 'test-client-secret',
      };

      // Setup successful S3 mocks
      const hashKey = 'c5d6f7e8a9b0c1d2';
      mockS3Client.send.onFirstCall().resolves({
        Contents: [
          { Key: `fixes/${siteId}/${hashKey}/rule-123456789/report.json` },
          { Key: `fixes/${siteId}/${hashKey}/rule-123456789/assets/blocks/form/form.js` },
        ],
      });
      mockS3Client.send.onSecondCall().resolves({
        Body: {
          transformToString: async () => JSON.stringify({
            type: 'aria-allowed-attr',
            updatedFiles: ['blocks/form/form.js'],
          }),
        },
      });
      mockS3Client.send.onThirdCall().resolves({
        Body: { transformToString: async () => 'file content' },
      });

      // Make getServiceAccessToken throw an error without message property
      const errorWithoutMessage = { code: 'IMS_ERROR' };
      requestContext.imsClient.getServiceAccessToken.throws(errorWithoutMessage);

      const response = await fixesController.applyAccessibilityFix(requestContext);
      expect(response).includes({ status: 500 });
      expect(await response.json()).deep.equals({ message: 'Authentication failed' });
    });
  });
});

const ISO_DATE = '2025-05-19T01:23:45.678Z';
function fakeCreateFix(data) {
  data.fixEntityId ??= crypto.randomUUID();
  data.status ??= FixEntity.STATUSES.PENDING;
  data.changeDetails ??= { arbitrary: 'details' };
  data.createdAt ??= ISO_DATE;
  data.executedAt ??= ISO_DATE;
  data.executedBy ??= 'test user';
  data.publishedAt ??= ISO_DATE;

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
