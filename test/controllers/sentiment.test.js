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

import AuthInfo from '@adobe/spacecat-shared-http-utils/src/auth/auth-info.js';
import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';

import SentimentController from '../../src/controllers/sentiment.js';
import AccessControlUtil from '../../src/support/access-control-util.js';

use(chaiAsPromised);
use(sinonChai);

const siteId = '3f1c3ab1-9ad0-4231-ac87-8159acf52cb6';
const topicUUID = '4a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const guidelineUUID = '5b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e';

describe('Sentiment Controller', () => {
  const sandbox = sinon.createSandbox();

  const controllerFunctions = [
    'listTopics',
    'getTopic',
    'createTopics',
    'updateTopic',
    'deleteTopic',
    'addSubPrompts',
    'removeSubPrompts',
    'linkAudits',
    'unlinkAudits',
    'listGuidelines',
    'getGuideline',
    'createGuidelines',
    'updateGuideline',
    'deleteGuideline',
    'getConfig',
  ];

  const createMockTopic = (data) => ({
    getSiteId: () => data.siteId || siteId,
    getTopicId: () => data.topicId || topicUUID,
    getName: () => data.name || 'Test Topic',
    getDescription: () => data.description,
    getSubPrompts: () => data.subPrompts || [],
    getEnabled: () => data.enabled !== false,
    getCreatedAt: () => data.createdAt || '2026-01-01T00:00:00Z',
    getUpdatedAt: () => data.updatedAt || '2026-01-01T00:00:00Z',
    getCreatedBy: () => data.createdBy || 'system',
    getUpdatedBy: () => data.updatedBy || 'system',
    setName: sandbox.stub(),
    setDescription: sandbox.stub(),
    setSubPrompts: sandbox.stub(),
    setEnabled: sandbox.stub(),
    setUpdatedBy: sandbox.stub(),
    addSubPrompt: sandbox.stub(),
    removeSubPrompt: sandbox.stub(),
    save: sandbox.stub().resolvesThis(),
    remove: sandbox.stub().resolves(),
  });

  const createMockGuideline = (data) => ({
    getSiteId: () => data.siteId || siteId,
    getGuidelineId: () => data.guidelineId || guidelineUUID,
    getName: () => data.name || 'Test Guideline',
    getInstruction: () => data.instruction || 'Test instruction',
    getAudits: () => data.audits || [],
    getEnabled: () => data.enabled !== false,
    getCreatedAt: () => data.createdAt || '2026-01-01T00:00:00Z',
    getUpdatedAt: () => data.updatedAt || '2026-01-01T00:00:00Z',
    getCreatedBy: () => data.createdBy || 'system',
    getUpdatedBy: () => data.updatedBy || 'system',
    setName: sandbox.stub(),
    setInstruction: sandbox.stub(),
    setAudits: sandbox.stub(),
    setEnabled: sandbox.stub(),
    setUpdatedBy: sandbox.stub(),
    enableAudit: sandbox.stub(),
    disableAudit: sandbox.stub(),
    save: sandbox.stub().resolvesThis(),
    remove: sandbox.stub().resolves(),
  });

  const mockTopics = [
    createMockTopic({ topicId: topicUUID, name: 'Topic 1' }),
    createMockTopic({ topicId: 'topic-2', name: 'Topic 2' }),
  ];

  const mockGuidelines = [
    createMockGuideline({ guidelineId: guidelineUUID, name: 'Guideline 1' }),
    createMockGuideline({ guidelineId: 'guideline-2', name: 'Guideline 2' }),
  ];

  let mockDataAccess;
  let sentimentController;
  let context;
  let log;

  beforeEach(() => {
    log = {
      info: sandbox.stub(),
      error: sandbox.stub(),
      warn: sandbox.stub(),
      debug: sandbox.stub(),
    };

    mockDataAccess = {
      Site: {
        findById: sandbox.stub().resolves({ siteId }),
      },
      SentimentTopic: {
        allBySiteId: sandbox.stub().resolves({ data: mockTopics, cursor: null }),
        allBySiteIdEnabled: sandbox.stub().resolves({ data: mockTopics, cursor: null }),
        allBySiteIdAndAuditType: sandbox.stub().resolves({ data: mockTopics, cursor: null }),
        findById: sandbox.stub().resolves(mockTopics[0]),
        create: sandbox.stub().resolves(mockTopics[0]),
      },
      SentimentGuideline: {
        allBySiteId: sandbox.stub().resolves({ data: mockGuidelines, cursor: null }),
        allBySiteIdEnabled: sandbox.stub().resolves({ data: mockGuidelines, cursor: null }),
        allBySiteIdAndAuditType: sandbox.stub().resolves({ data: mockGuidelines, cursor: null }),
        findById: sandbox.stub().resolves(mockGuidelines[0]),
        findByIds: sandbox.stub().resolves(mockGuidelines),
        create: sandbox.stub().resolves(mockGuidelines[0]),
      },
    };

    context = {
      params: { siteId },
      data: {},
      dataAccess: mockDataAccess,
      pathInfo: {
        headers: { 'x-product': 'abcd' },
      },
      attributes: {
        authInfo: new AuthInfo()
          .withType('jwt')
          .withScopes([{ name: 'admin' }])
          .withProfile({ is_admin: true })
          .withAuthenticated(true),
      },
    };

    sentimentController = SentimentController(context, log);
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('contains all controller functions', () => {
    controllerFunctions.forEach((funcName) => {
      expect(sentimentController).to.have.property(funcName);
    });
  });

  it('does not contain any unexpected functions', () => {
    Object.keys(sentimentController).forEach((funcName) => {
      expect(controllerFunctions).to.include(funcName);
    });
  });

  it('throws an error if context is not an object', () => {
    expect(() => SentimentController()).to.throw('Context required');
  });

  it('throws an error if context is empty', () => {
    expect(() => SentimentController({})).to.throw('Context required');
  });

  it('throws an error if data access is not an object', () => {
    expect(() => SentimentController({ dataAccess: {} })).to.throw('Data access required');
  });

  // ========== TOPIC TESTS ==========

  describe('listTopics', () => {
    it('returns bad request for invalid siteId', async () => {
      context.params.siteId = 'invalid';
      const result = await sentimentController.listTopics(context);
      expect(result.status).to.equal(400);
    });

    it('returns bad request for invalid limit', async () => {
      context.data = { limit: 'abc' };
      const result = await sentimentController.listTopics(context);
      expect(result.status).to.equal(400);
    });

    it('returns not found if site does not exist', async () => {
      mockDataAccess.Site.findById.resolves(null);
      const result = await sentimentController.listTopics(context);
      expect(result.status).to.equal(404);
    });

    it('returns topics with pagination', async () => {
      const result = await sentimentController.listTopics(context);
      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.items).to.be.an('array');
      expect(body.pagination).to.have.property('limit');
    });

    it('returns topics when context.data is undefined', async () => {
      context.data = undefined;
      const result = await sentimentController.listTopics(context);
      expect(result.status).to.equal(200);
    });

    it('returns empty array when result.data is null', async () => {
      mockDataAccess.SentimentTopic.allBySiteId.resolves({ data: null, cursor: null });
      const result = await sentimentController.listTopics(context);
      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.items).to.deep.equal([]);
    });

    it('filters by enabled when provided', async () => {
      context.data = { enabled: 'true' };
      const result = await sentimentController.listTopics(context);
      expect(result.status).to.equal(200);
      expect(mockDataAccess.SentimentTopic.allBySiteIdEnabled).to.have.been.called;
    });

    it('returns forbidden if user does not have access', async () => {
      sandbox.stub(AccessControlUtil.prototype, 'hasAccess').returns(false);
      const result = await sentimentController.listTopics(context);
      expect(result.status).to.equal(403);
    });

    it('handles errors gracefully', async () => {
      mockDataAccess.SentimentTopic.allBySiteId.rejects(new Error('DB error'));
      const result = await sentimentController.listTopics(context);
      expect(result.status).to.equal(500);
    });
  });

  describe('getTopic', () => {
    beforeEach(() => {
      context.params.topicId = topicUUID;
    });

    it('returns bad request for invalid siteId', async () => {
      context.params.siteId = 'invalid';
      const result = await sentimentController.getTopic(context);
      expect(result.status).to.equal(400);
    });

    it('returns bad request for missing topicId', async () => {
      context.params.topicId = '';
      const result = await sentimentController.getTopic(context);
      expect(result.status).to.equal(400);
    });

    it('returns bad request for invalid topicId format', async () => {
      context.params.topicId = 'invalid-topic-id';
      const result = await sentimentController.getTopic(context);
      expect(result.status).to.equal(400);
    });

    it('returns not found if site does not exist', async () => {
      mockDataAccess.Site.findById.resolves(null);
      const result = await sentimentController.getTopic(context);
      expect(result.status).to.equal(404);
    });

    it('returns not found if topic does not exist', async () => {
      mockDataAccess.SentimentTopic.findById.resolves(null);
      const result = await sentimentController.getTopic(context);
      expect(result.status).to.equal(404);
    });

    it('returns topic by id', async () => {
      const result = await sentimentController.getTopic(context);
      expect(result.status).to.equal(200);
    });

    it('returns forbidden if user does not have access', async () => {
      sandbox.stub(AccessControlUtil.prototype, 'hasAccess').returns(false);
      const result = await sentimentController.getTopic(context);
      expect(result.status).to.equal(403);
    });

    it('handles errors gracefully', async () => {
      mockDataAccess.SentimentTopic.findById.rejects(new Error('DB error'));
      const result = await sentimentController.getTopic(context);
      expect(result.status).to.equal(500);
    });
  });

  describe('createTopics', () => {
    it('returns bad request for invalid siteId', async () => {
      context.params.siteId = 'invalid';
      const result = await sentimentController.createTopics(context);
      expect(result.status).to.equal(400);
    });

    it('returns bad request if topics is not an array', async () => {
      context.data = { name: 'Topic' };
      const result = await sentimentController.createTopics(context);
      expect(result.status).to.equal(400);
    });

    it('returns bad request if topics array is empty', async () => {
      context.data = [];
      const result = await sentimentController.createTopics(context);
      expect(result.status).to.equal(400);
    });

    it('returns bad request if topics exceed max limit', async () => {
      context.data = Array(101).fill({ name: 'Topic' });
      const result = await sentimentController.createTopics(context);
      expect(result.status).to.equal(400);
    });

    it('returns not found if site does not exist', async () => {
      mockDataAccess.Site.findById.resolves(null);
      context.data = [{ name: 'Topic' }];
      const result = await sentimentController.createTopics(context);
      expect(result.status).to.equal(404);
    });

    it('returns forbidden if user does not have access', async () => {
      sandbox.stub(AccessControlUtil.prototype, 'hasAccess').returns(false);
      context.data = [{ name: 'Topic' }];
      const result = await sentimentController.createTopics(context);
      expect(result.status).to.equal(403);
    });

    it('creates topics successfully', async () => {
      context.data = [{ name: 'New Topic' }];
      const result = await sentimentController.createTopics(context);
      expect(result.status).to.equal(201);
    });

    it('creates topics with system user when authInfo is missing', async () => {
      const contextWithoutAuth = {
        ...context,
        attributes: {},
      };
      contextWithoutAuth.data = [{ name: 'New Topic' }];
      const result = await sentimentController.createTopics(contextWithoutAuth);
      expect(result.status).to.equal(201);
    });

    it('creates topics with non-array subPrompts defaulting to empty array', async () => {
      context.data = [{ name: 'New Topic', subPrompts: 'not-an-array' }];
      const result = await sentimentController.createTopics(context);
      expect(result.status).to.equal(201);
    });

    it('creates topics with array subPrompts', async () => {
      context.data = [{ name: 'New Topic', subPrompts: ['prompt1', 'prompt2'] }];
      const result = await sentimentController.createTopics(context);
      expect(result.status).to.equal(201);
    });

    it('uses profile.name when email is not available', async () => {
      const authInfoWithNameOnly = new AuthInfo()
        .withType('jwt')
        .withScopes([{ name: 'admin' }])
        .withProfile({ is_admin: true, name: 'Test User' })
        .withAuthenticated(true);
      const contextWithName = {
        ...context,
        attributes: { authInfo: authInfoWithNameOnly },
      };
      contextWithName.data = [{ name: 'New Topic' }];
      const result = await sentimentController.createTopics(contextWithName);
      expect(result.status).to.equal(201);
    });

    it('reports creation errors as failures', async () => {
      mockDataAccess.SentimentTopic.create.rejects(new Error('DB error'));
      context.data = [{ name: 'Error Topic' }];
      const result = await sentimentController.createTopics(context);
      expect(result.status).to.equal(201);
      const body = await result.json();
      expect(body.failures).to.have.lengthOf(1);
      expect(body.failures[0].reason).to.equal('DB error');
    });

    it('reports validation failures for missing name', async () => {
      context.data = [{ description: 'No name' }];
      const result = await sentimentController.createTopics(context);
      expect(result.status).to.equal(201);
      const body = await result.json();
      expect(body.failures).to.have.lengthOf(1);
    });
  });

  describe('updateTopic', () => {
    beforeEach(() => {
      context.params.topicId = topicUUID;
    });

    it('returns bad request for invalid siteId', async () => {
      context.params.siteId = 'invalid';
      const result = await sentimentController.updateTopic(context);
      expect(result.status).to.equal(400);
    });

    it('returns bad request for missing topicId', async () => {
      context.params.topicId = '';
      const result = await sentimentController.updateTopic(context);
      expect(result.status).to.equal(400);
    });

    it('returns bad request for empty update data', async () => {
      context.data = {};
      const result = await sentimentController.updateTopic(context);
      expect(result.status).to.equal(400);
    });

    it('returns bad request for invalid audit types', async () => {
      context.data = { audits: ['invalid-audit'] };
      const result = await sentimentController.updateTopic(context);
      expect(result.status).to.equal(400);
    });

    it('handles audits as non-array gracefully', async () => {
      context.data = { audits: 'not-an-array' };
      const result = await sentimentController.updateTopic(context);
      expect(result.status).to.equal(200);
    });

    it('returns not found if site does not exist', async () => {
      mockDataAccess.Site.findById.resolves(null);
      context.data = { name: 'Updated' };
      const result = await sentimentController.updateTopic(context);
      expect(result.status).to.equal(404);
    });

    it('returns not found if topic does not exist', async () => {
      mockDataAccess.SentimentTopic.findById.resolves(null);
      context.data = { name: 'Updated' };
      const result = await sentimentController.updateTopic(context);
      expect(result.status).to.equal(404);
    });

    it('updates topic successfully', async () => {
      context.data = { name: 'Updated Topic', enabled: false };
      const result = await sentimentController.updateTopic(context);
      expect(result.status).to.equal(200);
    });

    it('updates topic description', async () => {
      context.data = { description: 'Updated description' };
      const result = await sentimentController.updateTopic(context);
      expect(result.status).to.equal(200);
    });

    it('updates topic subPrompts', async () => {
      context.data = { subPrompts: ['prompt1', 'prompt2'] };
      const result = await sentimentController.updateTopic(context);
      expect(result.status).to.equal(200);
    });

    it('returns forbidden if user does not have access', async () => {
      sandbox.stub(AccessControlUtil.prototype, 'hasAccess').returns(false);
      context.data = { name: 'Updated' };
      const result = await sentimentController.updateTopic(context);
      expect(result.status).to.equal(403);
    });

    it('handles errors gracefully', async () => {
      context.data = { name: 'Updated' };
      mockDataAccess.SentimentTopic.findById.rejects(new Error('DB error'));
      const result = await sentimentController.updateTopic(context);
      expect(result.status).to.equal(500);
    });
  });

  describe('deleteTopic', () => {
    beforeEach(() => {
      context.params.topicId = topicUUID;
    });

    it('returns bad request for invalid siteId', async () => {
      context.params.siteId = 'invalid';
      const result = await sentimentController.deleteTopic(context);
      expect(result.status).to.equal(400);
    });

    it('returns bad request for missing topicId', async () => {
      context.params.topicId = '';
      const result = await sentimentController.deleteTopic(context);
      expect(result.status).to.equal(400);
    });

    it('returns not found if site does not exist', async () => {
      mockDataAccess.Site.findById.resolves(null);
      const result = await sentimentController.deleteTopic(context);
      expect(result.status).to.equal(404);
    });

    it('returns not found if topic does not exist', async () => {
      mockDataAccess.SentimentTopic.findById.resolves(null);
      const result = await sentimentController.deleteTopic(context);
      expect(result.status).to.equal(404);
    });

    it('deletes topic successfully', async () => {
      const result = await sentimentController.deleteTopic(context);
      expect(result.status).to.equal(200);
    });

    it('returns forbidden if user does not have access', async () => {
      sandbox.stub(AccessControlUtil.prototype, 'hasAccess').returns(false);
      const result = await sentimentController.deleteTopic(context);
      expect(result.status).to.equal(403);
    });

    it('handles errors gracefully', async () => {
      mockDataAccess.SentimentTopic.findById.rejects(new Error('DB error'));
      const result = await sentimentController.deleteTopic(context);
      expect(result.status).to.equal(500);
    });
  });

  describe('addSubPrompts', () => {
    beforeEach(() => {
      context.params.topicId = topicUUID;
    });

    it('returns bad request for invalid siteId', async () => {
      context.params.siteId = 'invalid';
      const result = await sentimentController.addSubPrompts(context);
      expect(result.status).to.equal(400);
    });

    it('returns bad request for missing topicId', async () => {
      context.params.topicId = '';
      const result = await sentimentController.addSubPrompts(context);
      expect(result.status).to.equal(400);
    });

    it('returns bad request for missing prompts', async () => {
      context.data = {};
      const result = await sentimentController.addSubPrompts(context);
      expect(result.status).to.equal(400);
    });

    it('returns bad request when context.data is undefined', async () => {
      context.data = undefined;
      const result = await sentimentController.addSubPrompts(context);
      expect(result.status).to.equal(400);
    });

    it('returns not found if site does not exist', async () => {
      mockDataAccess.Site.findById.resolves(null);
      context.data = { prompts: ['prompt1'] };
      const result = await sentimentController.addSubPrompts(context);
      expect(result.status).to.equal(404);
    });

    it('returns not found if topic does not exist', async () => {
      mockDataAccess.SentimentTopic.findById.resolves(null);
      context.data = { prompts: ['prompt1'] };
      const result = await sentimentController.addSubPrompts(context);
      expect(result.status).to.equal(404);
    });

    it('handles error gracefully', async () => {
      context.data = { prompts: ['prompt1'] };
      mockDataAccess.SentimentTopic.findById.rejects(new Error('DB error'));
      const result = await sentimentController.addSubPrompts(context);
      expect(result.status).to.equal(500);
    });

    it('adds prompts successfully', async () => {
      context.data = { prompts: ['prompt1', 'prompt2'] };
      const result = await sentimentController.addSubPrompts(context);
      expect(result.status).to.equal(200);
    });

    it('handles topic with null subPrompts', async () => {
      const topicWithNullPrompts = {
        getSiteId: () => siteId,
        getTopicId: () => topicUUID,
        getName: () => 'Test Topic',
        getDescription: () => undefined,
        getSubPrompts: () => null,
        getEnabled: () => true,
        getCreatedAt: () => '2026-01-01T00:00:00Z',
        getUpdatedAt: () => '2026-01-01T00:00:00Z',
        getCreatedBy: () => 'system',
        getUpdatedBy: () => 'system',
        setUpdatedBy: sandbox.stub(),
        addSubPrompt: sandbox.stub(),
        save: sandbox.stub().resolvesThis(),
      };
      mockDataAccess.SentimentTopic.findById.resolves(topicWithNullPrompts);
      context.data = { prompts: ['prompt1'] };
      const result = await sentimentController.addSubPrompts(context);
      expect(result.status).to.equal(200);
    });

    it('returns forbidden if user does not have access', async () => {
      sandbox.stub(AccessControlUtil.prototype, 'hasAccess').returns(false);
      context.data = { prompts: ['prompt1'] };
      const result = await sentimentController.addSubPrompts(context);
      expect(result.status).to.equal(403);
    });
  });

  describe('removeSubPrompts', () => {
    beforeEach(() => {
      context.params.topicId = topicUUID;
    });

    it('returns bad request for invalid siteId', async () => {
      context.params.siteId = 'invalid';
      const result = await sentimentController.removeSubPrompts(context);
      expect(result.status).to.equal(400);
    });

    it('returns bad request for missing topicId', async () => {
      context.params.topicId = '';
      const result = await sentimentController.removeSubPrompts(context);
      expect(result.status).to.equal(400);
    });

    it('returns bad request for missing prompts', async () => {
      context.data = {};
      const result = await sentimentController.removeSubPrompts(context);
      expect(result.status).to.equal(400);
    });

    it('returns bad request when context.data is undefined', async () => {
      context.data = undefined;
      const result = await sentimentController.removeSubPrompts(context);
      expect(result.status).to.equal(400);
    });

    it('returns not found if site does not exist', async () => {
      mockDataAccess.Site.findById.resolves(null);
      context.data = { prompts: ['prompt1'] };
      const result = await sentimentController.removeSubPrompts(context);
      expect(result.status).to.equal(404);
    });

    it('returns not found if topic does not exist', async () => {
      mockDataAccess.SentimentTopic.findById.resolves(null);
      context.data = { prompts: ['prompt1'] };
      const result = await sentimentController.removeSubPrompts(context);
      expect(result.status).to.equal(404);
    });

    it('handles error gracefully', async () => {
      context.data = { prompts: ['prompt1'] };
      mockDataAccess.SentimentTopic.findById.rejects(new Error('DB error'));
      const result = await sentimentController.removeSubPrompts(context);
      expect(result.status).to.equal(500);
    });

    it('removes prompts successfully', async () => {
      context.data = { prompts: ['prompt1'] };
      const result = await sentimentController.removeSubPrompts(context);
      expect(result.status).to.equal(200);
    });

    it('returns forbidden if user does not have access', async () => {
      sandbox.stub(AccessControlUtil.prototype, 'hasAccess').returns(false);
      context.data = { prompts: ['prompt1'] };
      const result = await sentimentController.removeSubPrompts(context);
      expect(result.status).to.equal(403);
    });
  });

  describe('linkAudits', () => {
    beforeEach(() => {
      context.params.guidelineId = guidelineUUID;
    });

    it('returns bad request for invalid siteId', async () => {
      context.params.siteId = 'invalid';
      const result = await sentimentController.linkAudits(context);
      expect(result.status).to.equal(400);
    });

    it('returns bad request for missing guidelineId', async () => {
      context.params.guidelineId = '';
      const result = await sentimentController.linkAudits(context);
      expect(result.status).to.equal(400);
    });

    it('returns bad request for missing audits', async () => {
      context.data = {};
      const result = await sentimentController.linkAudits(context);
      expect(result.status).to.equal(400);
    });

    it('returns bad request when context.data is undefined', async () => {
      context.data = undefined;
      const result = await sentimentController.linkAudits(context);
      expect(result.status).to.equal(400);
    });

    it('returns bad request for invalid audit types', async () => {
      context.data = { audits: ['invalid-audit'] };
      const result = await sentimentController.linkAudits(context);
      expect(result.status).to.equal(400);
    });

    it('returns not found if site does not exist', async () => {
      mockDataAccess.Site.findById.resolves(null);
      context.data = { audits: ['wikipedia-analysis'] };
      const result = await sentimentController.linkAudits(context);
      expect(result.status).to.equal(404);
    });

    it('returns not found if guideline does not exist', async () => {
      mockDataAccess.SentimentGuideline.findById.resolves(null);
      context.data = { audits: ['wikipedia-analysis'] };
      const result = await sentimentController.linkAudits(context);
      expect(result.status).to.equal(404);
    });

    it('handles error gracefully', async () => {
      context.data = { audits: ['wikipedia-analysis'] };
      mockDataAccess.SentimentGuideline.findById.rejects(new Error('DB error'));
      const result = await sentimentController.linkAudits(context);
      expect(result.status).to.equal(500);
    });

    it('links audits successfully', async () => {
      context.data = { audits: ['wikipedia-analysis'] };
      const result = await sentimentController.linkAudits(context);
      expect(result.status).to.equal(200);
    });

    it('returns forbidden if user does not have access', async () => {
      sandbox.stub(AccessControlUtil.prototype, 'hasAccess').returns(false);
      context.data = { audits: ['wikipedia-analysis'] };
      const result = await sentimentController.linkAudits(context);
      expect(result.status).to.equal(403);
    });
  });

  describe('unlinkAudits', () => {
    beforeEach(() => {
      context.params.guidelineId = guidelineUUID;
    });

    it('returns bad request for invalid siteId', async () => {
      context.params.siteId = 'invalid';
      const result = await sentimentController.unlinkAudits(context);
      expect(result.status).to.equal(400);
    });

    it('returns bad request for missing guidelineId', async () => {
      context.params.guidelineId = '';
      const result = await sentimentController.unlinkAudits(context);
      expect(result.status).to.equal(400);
    });

    it('returns bad request for missing audits', async () => {
      context.data = {};
      const result = await sentimentController.unlinkAudits(context);
      expect(result.status).to.equal(400);
    });

    it('returns bad request when context.data is undefined', async () => {
      context.data = undefined;
      const result = await sentimentController.unlinkAudits(context);
      expect(result.status).to.equal(400);
    });

    it('returns not found if site does not exist', async () => {
      mockDataAccess.Site.findById.resolves(null);
      context.data = { audits: ['wikipedia-analysis'] };
      const result = await sentimentController.unlinkAudits(context);
      expect(result.status).to.equal(404);
    });

    it('returns not found if guideline does not exist', async () => {
      mockDataAccess.SentimentGuideline.findById.resolves(null);
      context.data = { audits: ['wikipedia-analysis'] };
      const result = await sentimentController.unlinkAudits(context);
      expect(result.status).to.equal(404);
    });

    it('handles error gracefully', async () => {
      context.data = { audits: ['wikipedia-analysis'] };
      mockDataAccess.SentimentGuideline.findById.rejects(new Error('DB error'));
      const result = await sentimentController.unlinkAudits(context);
      expect(result.status).to.equal(500);
    });

    it('unlinks audits successfully', async () => {
      context.data = { audits: ['wikipedia-analysis'] };
      const result = await sentimentController.unlinkAudits(context);
      expect(result.status).to.equal(200);
    });

    it('returns forbidden if user does not have access', async () => {
      sandbox.stub(AccessControlUtil.prototype, 'hasAccess').returns(false);
      context.data = { audits: ['wikipedia-analysis'] };
      const result = await sentimentController.unlinkAudits(context);
      expect(result.status).to.equal(403);
    });
  });

  // ========== GUIDELINE TESTS ==========

  describe('listGuidelines', () => {
    it('returns bad request for invalid siteId', async () => {
      context.params.siteId = 'invalid';
      const result = await sentimentController.listGuidelines(context);
      expect(result.status).to.equal(400);
    });

    it('returns bad request for invalid limit', async () => {
      context.data = { limit: 'abc' };
      const result = await sentimentController.listGuidelines(context);
      expect(result.status).to.equal(400);
    });

    it('returns not found if site does not exist', async () => {
      mockDataAccess.Site.findById.resolves(null);
      const result = await sentimentController.listGuidelines(context);
      expect(result.status).to.equal(404);
    });

    it('returns guidelines with pagination', async () => {
      const result = await sentimentController.listGuidelines(context);
      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.items).to.be.an('array');
    });

    it('returns guidelines when context.data is undefined', async () => {
      context.data = undefined;
      const result = await sentimentController.listGuidelines(context);
      expect(result.status).to.equal(200);
    });

    it('returns empty array when result.data is null', async () => {
      mockDataAccess.SentimentGuideline.allBySiteId.resolves({ data: null, cursor: null });
      const result = await sentimentController.listGuidelines(context);
      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.items).to.deep.equal([]);
    });

    it('filters by enabled when provided', async () => {
      context.data = { enabled: 'true' };
      const result = await sentimentController.listGuidelines(context);
      expect(result.status).to.equal(200);
      expect(mockDataAccess.SentimentGuideline.allBySiteIdEnabled).to.have.been.called;
    });

    it('returns forbidden if user does not have access', async () => {
      sandbox.stub(AccessControlUtil.prototype, 'hasAccess').returns(false);
      const result = await sentimentController.listGuidelines(context);
      expect(result.status).to.equal(403);
    });

    it('handles errors gracefully', async () => {
      mockDataAccess.SentimentGuideline.allBySiteId.rejects(new Error('DB error'));
      const result = await sentimentController.listGuidelines(context);
      expect(result.status).to.equal(500);
    });
  });

  describe('getGuideline', () => {
    beforeEach(() => {
      context.params.guidelineId = guidelineUUID;
    });

    it('returns bad request for invalid siteId', async () => {
      context.params.siteId = 'invalid';
      const result = await sentimentController.getGuideline(context);
      expect(result.status).to.equal(400);
    });

    it('returns bad request for missing guidelineId', async () => {
      context.params.guidelineId = '';
      const result = await sentimentController.getGuideline(context);
      expect(result.status).to.equal(400);
    });

    it('returns bad request for invalid guidelineId format', async () => {
      context.params.guidelineId = 'invalid-guideline-id';
      const result = await sentimentController.getGuideline(context);
      expect(result.status).to.equal(400);
    });

    it('returns not found if site does not exist', async () => {
      mockDataAccess.Site.findById.resolves(null);
      const result = await sentimentController.getGuideline(context);
      expect(result.status).to.equal(404);
    });

    it('returns not found if guideline does not exist', async () => {
      mockDataAccess.SentimentGuideline.findById.resolves(null);
      const result = await sentimentController.getGuideline(context);
      expect(result.status).to.equal(404);
    });

    it('returns guideline by id', async () => {
      const result = await sentimentController.getGuideline(context);
      expect(result.status).to.equal(200);
    });

    it('returns forbidden if user does not have access', async () => {
      sandbox.stub(AccessControlUtil.prototype, 'hasAccess').returns(false);
      const result = await sentimentController.getGuideline(context);
      expect(result.status).to.equal(403);
    });

    it('handles errors gracefully', async () => {
      mockDataAccess.SentimentGuideline.findById.rejects(new Error('DB error'));
      const result = await sentimentController.getGuideline(context);
      expect(result.status).to.equal(500);
    });
  });

  describe('createGuidelines', () => {
    it('returns bad request for invalid siteId', async () => {
      context.params.siteId = 'invalid';
      const result = await sentimentController.createGuidelines(context);
      expect(result.status).to.equal(400);
    });

    it('returns bad request if guidelines is not an array', async () => {
      context.data = { name: 'Guideline' };
      const result = await sentimentController.createGuidelines(context);
      expect(result.status).to.equal(400);
    });

    it('returns bad request if guidelines array is empty', async () => {
      context.data = [];
      const result = await sentimentController.createGuidelines(context);
      expect(result.status).to.equal(400);
    });

    it('returns bad request if guidelines exceed max limit', async () => {
      context.data = Array(101).fill({ name: 'Guideline', instruction: 'Test' });
      const result = await sentimentController.createGuidelines(context);
      expect(result.status).to.equal(400);
    });

    it('returns not found if site does not exist', async () => {
      mockDataAccess.Site.findById.resolves(null);
      context.data = [{ name: 'Guideline', instruction: 'Test' }];
      const result = await sentimentController.createGuidelines(context);
      expect(result.status).to.equal(404);
    });

    it('returns forbidden if user does not have access', async () => {
      sandbox.stub(AccessControlUtil.prototype, 'hasAccess').returns(false);
      context.data = [{ name: 'Guideline', instruction: 'Test' }];
      const result = await sentimentController.createGuidelines(context);
      expect(result.status).to.equal(403);
    });

    it('creates guidelines successfully', async () => {
      context.data = [{ name: 'New Guideline', instruction: 'Test instruction' }];
      const result = await sentimentController.createGuidelines(context);
      expect(result.status).to.equal(201);
    });

    it('creates guidelines with non-array audits defaulting to empty array', async () => {
      context.data = [{ name: 'New Guideline', instruction: 'Test instruction', audits: 'not-an-array' }];
      const result = await sentimentController.createGuidelines(context);
      expect(result.status).to.equal(201);
    });

    it('creates guidelines with array audits', async () => {
      context.data = [{ name: 'New Guideline', instruction: 'Test instruction', audits: ['wikipedia-analysis'] }];
      const result = await sentimentController.createGuidelines(context);
      expect(result.status).to.equal(201);
    });

    it('reports validation failures for invalid audit types', async () => {
      context.data = [{ name: 'Guideline', instruction: 'Test', audits: ['invalid-audit'] }];
      const result = await sentimentController.createGuidelines(context);
      expect(result.status).to.equal(201);
      const body = await result.json();
      expect(body.failures).to.have.lengthOf(1);
      expect(body.failures[0].reason).to.include('Invalid audit types');
    });

    it('reports validation failures for missing name', async () => {
      context.data = [{ instruction: 'No name' }];
      const result = await sentimentController.createGuidelines(context);
      expect(result.status).to.equal(201);
      const body = await result.json();
      expect(body.failures).to.have.lengthOf(1);
    });

    it('reports validation failures for missing instruction', async () => {
      context.data = [{ name: 'No instruction' }];
      const result = await sentimentController.createGuidelines(context);
      expect(result.status).to.equal(201);
      const body = await result.json();
      expect(body.failures).to.have.lengthOf(1);
    });

    it('reports creation errors as failures', async () => {
      mockDataAccess.SentimentGuideline.create.rejects(new Error('DB error'));
      context.data = [{ name: 'Error Guideline', instruction: 'Test' }];
      const result = await sentimentController.createGuidelines(context);
      expect(result.status).to.equal(201);
      const body = await result.json();
      expect(body.failures).to.have.lengthOf(1);
      expect(body.failures[0].reason).to.equal('DB error');
    });
  });

  describe('updateGuideline', () => {
    beforeEach(() => {
      context.params.guidelineId = guidelineUUID;
    });

    it('returns bad request for invalid siteId', async () => {
      context.params.siteId = 'invalid';
      const result = await sentimentController.updateGuideline(context);
      expect(result.status).to.equal(400);
    });

    it('returns bad request for missing guidelineId', async () => {
      context.params.guidelineId = '';
      const result = await sentimentController.updateGuideline(context);
      expect(result.status).to.equal(400);
    });

    it('returns bad request for empty update data', async () => {
      context.data = {};
      const result = await sentimentController.updateGuideline(context);
      expect(result.status).to.equal(400);
    });

    it('returns not found if site does not exist', async () => {
      mockDataAccess.Site.findById.resolves(null);
      context.data = { name: 'Updated' };
      const result = await sentimentController.updateGuideline(context);
      expect(result.status).to.equal(404);
    });

    it('returns not found if guideline does not exist', async () => {
      mockDataAccess.SentimentGuideline.findById.resolves(null);
      context.data = { name: 'Updated' };
      const result = await sentimentController.updateGuideline(context);
      expect(result.status).to.equal(404);
    });

    it('updates guideline successfully', async () => {
      context.data = { name: 'Updated Guideline', enabled: false };
      const result = await sentimentController.updateGuideline(context);
      expect(result.status).to.equal(200);
    });

    it('updates guideline instruction', async () => {
      context.data = { instruction: 'Updated instruction' };
      const result = await sentimentController.updateGuideline(context);
      expect(result.status).to.equal(200);
    });

    it('updates guideline audits', async () => {
      context.data = { audits: ['wikipedia-analysis'] };
      const result = await sentimentController.updateGuideline(context);
      expect(result.status).to.equal(200);
    });

    it('returns bad request for invalid audit types', async () => {
      context.data = { audits: ['invalid-audit-type'] };
      const result = await sentimentController.updateGuideline(context);
      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.include('Invalid audit types');
    });

    it('returns forbidden if user does not have access', async () => {
      sandbox.stub(AccessControlUtil.prototype, 'hasAccess').returns(false);
      context.data = { name: 'Updated' };
      const result = await sentimentController.updateGuideline(context);
      expect(result.status).to.equal(403);
    });

    it('handles errors gracefully', async () => {
      context.data = { name: 'Updated' };
      mockDataAccess.SentimentGuideline.findById.rejects(new Error('DB error'));
      const result = await sentimentController.updateGuideline(context);
      expect(result.status).to.equal(500);
    });
  });

  describe('deleteGuideline', () => {
    beforeEach(() => {
      context.params.guidelineId = guidelineUUID;
    });

    it('returns bad request for invalid siteId', async () => {
      context.params.siteId = 'invalid';
      const result = await sentimentController.deleteGuideline(context);
      expect(result.status).to.equal(400);
    });

    it('returns bad request for missing guidelineId', async () => {
      context.params.guidelineId = '';
      const result = await sentimentController.deleteGuideline(context);
      expect(result.status).to.equal(400);
    });

    it('returns not found if site does not exist', async () => {
      mockDataAccess.Site.findById.resolves(null);
      const result = await sentimentController.deleteGuideline(context);
      expect(result.status).to.equal(404);
    });

    it('returns not found if guideline does not exist', async () => {
      mockDataAccess.SentimentGuideline.findById.resolves(null);
      const result = await sentimentController.deleteGuideline(context);
      expect(result.status).to.equal(404);
    });

    it('deletes guideline successfully', async () => {
      const result = await sentimentController.deleteGuideline(context);
      expect(result.status).to.equal(200);
    });

    it('returns forbidden if user does not have access', async () => {
      sandbox.stub(AccessControlUtil.prototype, 'hasAccess').returns(false);
      const result = await sentimentController.deleteGuideline(context);
      expect(result.status).to.equal(403);
    });

    it('handles errors gracefully', async () => {
      mockDataAccess.SentimentGuideline.findById.rejects(new Error('DB error'));
      const result = await sentimentController.deleteGuideline(context);
      expect(result.status).to.equal(500);
    });
  });

  // ========== CONFIG TEST ==========

  describe('getConfig', () => {
    it('returns bad request for invalid siteId', async () => {
      context.params.siteId = 'invalid';
      const result = await sentimentController.getConfig(context);
      expect(result.status).to.equal(400);
    });

    it('returns not found if site does not exist', async () => {
      mockDataAccess.Site.findById.resolves(null);
      const result = await sentimentController.getConfig(context);
      expect(result.status).to.equal(404);
    });

    it('returns config with topics and guidelines independently', async () => {
      const result = await sentimentController.getConfig(context);
      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.topics).to.be.an('array');
      expect(body.guidelines).to.be.an('array');
    });

    it('returns config when context.data is undefined', async () => {
      context.data = undefined;
      const result = await sentimentController.getConfig(context);
      expect(result.status).to.equal(200);
    });

    it('returns empty arrays when data is null', async () => {
      mockDataAccess.SentimentTopic.allBySiteIdEnabled.resolves({ data: null, cursor: null });
      mockDataAccess.SentimentGuideline.allBySiteIdEnabled.resolves({ data: null, cursor: null });
      const result = await sentimentController.getConfig(context);
      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.topics).to.deep.equal([]);
      expect(body.guidelines).to.deep.equal([]);
    });

    it('filters guidelines by audit when provided', async () => {
      context.data = { audit: 'wikipedia-analysis' };
      const result = await sentimentController.getConfig(context);
      expect(result.status).to.equal(200);
      expect(mockDataAccess.SentimentGuideline.allBySiteIdAndAuditType).to.have.been.called;
    });

    it('handles errors gracefully', async () => {
      mockDataAccess.SentimentTopic.allBySiteIdEnabled.rejects(new Error('DB error'));
      const result = await sentimentController.getConfig(context);
      expect(result.status).to.equal(500);
    });

    it('returns forbidden if user does not have access', async () => {
      sandbox.stub(AccessControlUtil.prototype, 'hasAccess').returns(false);
      const result = await sentimentController.getConfig(context);
      expect(result.status).to.equal(403);
    });
  });
});
