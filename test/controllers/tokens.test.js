/*
 * Copyright 2025 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import AuthInfo from '@adobe/spacecat-shared-http-utils/src/auth/auth-info.js';

import TokensController from '../../src/controllers/tokens.js';
import AccessControlUtil from '../../src/support/access-control-util.js';

use(chaiAsPromised);
use(sinonChai);

describe('Tokens Controller', () => {
  const sandbox = sinon.createSandbox();
  const siteId = '123e4567-e89b-12d3-a456-426614174000';
  const tokenId = '223e4567-e89b-12d3-a456-426614174001';

  const mockSite = {
    getId: () => siteId,
    getOrganizationId: () => 'org-123',
  };

  const mockToken = {
    getId: () => tokenId,
    getSiteId: () => siteId,
    getTokenType: () => 'monthly_suggestion_cwv',
    getCycle: () => '2025-03',
    getTotal: () => 100,
    getUsed: () => 25,
    getRemaining: () => 75,
    getCreatedAt: () => '2025-03-01T00:00:00Z',
    getUpdatedAt: () => '2025-03-10T00:00:00Z',
  };

  let mockDataAccess;
  let mockAccessControlUtil;
  let tokensController;

  beforeEach(() => {
    sandbox.restore();

    mockDataAccess = {
      Site: {
        findById: sandbox.stub().resolves(mockSite),
      },
      Token: {
        allBySiteId: sandbox.stub(),
        findBySiteIdAndTokenType: sandbox.stub().resolves(mockToken),
      },
    };

    mockAccessControlUtil = {
      hasAccess: sandbox.stub().resolves(true),
      hasAdminAccess: sandbox.stub().returns(true),
    };

    sandbox.stub(AccessControlUtil, 'fromContext').returns(mockAccessControlUtil);

    tokensController = TokensController({
      dataAccess: mockDataAccess,
      attributes: {
        authInfo: new AuthInfo()
          .withType('jwt')
          .withProfile({ is_admin: true })
          .withAuthenticated(true),
      },
    });
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('TokensController constructor', () => {
    it('should throw error when context is not provided', () => {
      expect(() => TokensController()).to.throw('Context required');
    });

    it('should throw error when context is null', () => {
      expect(() => TokensController(null)).to.throw('Context required');
    });

    it('should throw error when context is empty object', () => {
      expect(() => TokensController({})).to.throw('Context required');
    });

    it('should throw error when dataAccess is not provided', () => {
      expect(() => TokensController({ someOtherProp: 'value' })).to.throw('Data access required');
    });

    it('should throw error when dataAccess is null', () => {
      expect(() => TokensController({ dataAccess: null })).to.throw('Data access required');
    });

    it('should throw error when dataAccess is empty object', () => {
      expect(() => TokensController({ dataAccess: {} })).to.throw('Data access required');
    });
  });

  describe('getAll', () => {
    const mockToken2 = {
      getId: () => '323e4567-e89b-12d3-a456-426614174002',
      getSiteId: () => siteId,
      getTokenType: () => 'monthly_suggestion_lcp',
      getCycle: () => '2025-02',
      getTotal: () => 50,
      getUsed: () => 10,
      getRemaining: () => 40,
      getCreatedAt: () => '2025-03-01T00:00:00Z',
      getUpdatedAt: () => '2025-03-10T00:00:00Z',
    };

    beforeEach(() => {
      mockDataAccess.Token.allBySiteId.resolves({ data: [mockToken, mockToken2], cursor: null });
    });

    it('passes only base options to allBySiteId when no filters are applied', async () => {
      const context = {
        params: { siteId },
        data: { limit: 10 },
        log: { error: sinon.stub() },
      };

      const result = await tokensController.getAll(context);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body.tokens).to.have.lengthOf(2);
      expect(body.pagination).to.deep.equal({ limit: 10, cursor: null, hasMore: false });
      expect(mockDataAccess.Token.allBySiteId).to.have.been.calledWith(
        siteId,
        { limit: 10, cursor: undefined, returnCursor: true },
      );
    });

    it('passes tokenTypes to allBySiteId when provided as comma-separated string', async () => {
      const context = {
        params: { siteId },
        data: { tokenTypes: 'monthly_suggestion_cwv,monthly_suggestion_lcp' },
        log: { error: sinon.stub() },
      };

      await tokensController.getAll(context);

      expect(mockDataAccess.Token.allBySiteId).to.have.been.calledWith(
        siteId,
        sinon.match({ tokenTypes: ['monthly_suggestion_cwv', 'monthly_suggestion_lcp'] }),
      );
    });

    it('passes tokenTypes to allBySiteId when provided as an array', async () => {
      const context = {
        params: { siteId },
        data: { tokenTypes: ['monthly_suggestion_cwv', 'monthly_suggestion_lcp'] },
        log: { error: sinon.stub() },
      };

      await tokensController.getAll(context);

      expect(mockDataAccess.Token.allBySiteId).to.have.been.calledWith(
        siteId,
        sinon.match({ tokenTypes: ['monthly_suggestion_cwv', 'monthly_suggestion_lcp'] }),
      );
    });

    it('passes cycle to allBySiteId when provided', async () => {
      const context = {
        params: { siteId },
        data: { cycle: '2025-02' },
        log: { error: sinon.stub() },
      };

      await tokensController.getAll(context);

      expect(mockDataAccess.Token.allBySiteId).to.have.been.calledWith(
        siteId,
        sinon.match({ cycle: '2025-02' }),
      );
    });

    it('passes both tokenTypes and cycle to allBySiteId when provided together', async () => {
      const context = {
        params: { siteId },
        data: { tokenTypes: 'monthly_suggestion_lcp', cycle: '2025-03' },
        log: { error: sinon.stub() },
      };

      await tokensController.getAll(context);

      expect(mockDataAccess.Token.allBySiteId).to.have.been.calledWith(
        siteId,
        sinon.match({ tokenTypes: ['monthly_suggestion_lcp'], cycle: '2025-03' }),
      );
    });

    it('forwards cursor to allBySiteId and returns it in pagination', async () => {
      mockDataAccess.Token.allBySiteId.resolves({ data: [mockToken], cursor: 'next-page-token' });

      const context = {
        params: { siteId },
        data: { limit: 1, cursor: 'some-cursor' },
        log: { error: sinon.stub() },
      };

      const result = await tokensController.getAll(context);

      const body = await result.json();
      expect(body.pagination).to.deep.equal({ limit: 1, cursor: 'next-page-token', hasMore: true });
      expect(mockDataAccess.Token.allBySiteId).to.have.been.calledWith(
        siteId,
        sinon.match({ limit: 1, cursor: 'some-cursor', returnCursor: true }),
      );
    });

    it('returns empty tokens array when no tokens exist for the site', async () => {
      mockDataAccess.Token.allBySiteId.resolves({ data: [], cursor: null });

      const result = await tokensController.getAll({
        params: { siteId },
        data: {},
        log: { error: sinon.stub() },
      });

      const body = await result.json();
      expect(body.tokens).to.deep.equal([]);
      expect(body.pagination.hasMore).to.be.false;
    });

    it('caps limit at MAX_LIMIT (500)', async () => {
      const context = {
        params: { siteId },
        data: { limit: 9999 },
        log: { error: sinon.stub() },
      };

      await tokensController.getAll(context);

      expect(mockDataAccess.Token.allBySiteId).to.have.been.calledWith(
        siteId,
        { limit: 500, cursor: undefined, returnCursor: true },
      );
    });

    it('returns 400 for invalid site ID', async () => {
      const result = await tokensController.getAll({
        params: { siteId: 'invalid' },
        data: {},
      });
      expect(result.status).to.equal(400);
      expect((await result.json()).message).to.equal('Site ID required');
    });

    it('returns 400 for non-integer limit', async () => {
      const result = await tokensController.getAll({
        params: { siteId },
        data: { limit: 'abc' },
      });
      expect(result.status).to.equal(400);
      expect((await result.json()).message).to.equal('Limit must be a positive integer');
    });

    it('returns 400 for limit less than 1', async () => {
      const result = await tokensController.getAll({
        params: { siteId },
        data: { limit: 0 },
      });
      expect(result.status).to.equal(400);
      expect((await result.json()).message).to.equal('Limit must be a positive integer');
    });

    it('returns 404 when site does not exist', async () => {
      mockDataAccess.Site.findById.resolves(null);

      const result = await tokensController.getAll({
        params: { siteId },
        data: {},
        log: { error: sinon.stub() },
      });

      expect(result.status).to.equal(404);
      expect((await result.json()).message).to.equal('Site not found');
    });

    it('returns 403 when user lacks access', async () => {
      mockAccessControlUtil.hasAccess.resolves(false);

      const result = await tokensController.getAll({
        params: { siteId },
        data: {},
        log: { error: sinon.stub() },
      });

      expect(result.status).to.equal(403);
      expect((await result.json()).message).to.equal('Access denied to this site');
    });

    it('returns 500 on database failure', async () => {
      mockDataAccess.Token.allBySiteId.rejects(new Error('DB down'));

      const context = {
        params: { siteId },
        data: {},
        log: { error: sinon.stub() },
      };

      const result = await tokensController.getAll(context);

      expect(result.status).to.equal(500);
      expect((await result.json()).message).to.equal('DB down');
      expect(context.log.error).to.have.been.calledWith(
        `Error getting tokens for site ${siteId}: DB down`,
      );
    });
  });

  describe('getByTokenType', () => {
    it('should return a token by type for the current cycle', async () => {
      const context = {
        params: { siteId, tokenType: 'monthly_suggestion_cwv' },
        log: { error: sinon.stub() },
      };

      const result = await tokensController.getByTokenType(context);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body).to.deep.equal({
        id: tokenId,
        siteId,
        tokenType: 'monthly_suggestion_cwv',
        cycle: '2025-03',
        total: 100,
        used: 25,
        remaining: 75,
        createdAt: '2025-03-01T00:00:00Z',
        updatedAt: '2025-03-10T00:00:00Z',
      });

      expect(mockDataAccess.Token.findBySiteIdAndTokenType)
        .to.have.been.calledWith(siteId, 'monthly_suggestion_cwv', true);
    });

    it('should return bad request for invalid site ID', async () => {
      const context = {
        params: { siteId: 'invalid', tokenType: 'monthly_suggestion_cwv' },
      };

      const result = await tokensController.getByTokenType(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('Site ID required');
    });

    it('should return bad request for missing token type', async () => {
      const context = {
        params: { siteId, tokenType: '' },
      };

      const result = await tokensController.getByTokenType(context);

      expect(result.status).to.equal(400);
      const body = await result.json();
      expect(body.message).to.equal('Token type required');
    });

    it('should return not found when site does not exist', async () => {
      mockDataAccess.Site.findById.resolves(null);

      const context = {
        params: { siteId, tokenType: 'monthly_suggestion_cwv' },
        log: { error: sinon.stub() },
      };

      const result = await tokensController.getByTokenType(context);

      expect(result.status).to.equal(404);
      const body = await result.json();
      expect(body.message).to.equal('Site not found');
    });

    it('should return forbidden when user lacks access', async () => {
      mockAccessControlUtil.hasAccess.resolves(false);

      const context = {
        params: { siteId, tokenType: 'monthly_suggestion_cwv' },
        log: { error: sinon.stub() },
      };

      const result = await tokensController.getByTokenType(context);

      expect(result.status).to.equal(403);
      const body = await result.json();
      expect(body.message).to.equal('Access denied to this site');
    });

    it('should return not found when no token exists for the current cycle', async () => {
      mockDataAccess.Token.findBySiteIdAndTokenType.resolves(null);

      const context = {
        params: { siteId, tokenType: 'monthly_suggestion_cwv' },
        log: { error: sinon.stub() },
      };

      const result = await tokensController.getByTokenType(context);

      expect(result.status).to.equal(404);
      const body = await result.json();
      expect(body.message).to.equal('Token not found for the current cycle');
    });

    it('should return internal server error on database failure', async () => {
      const dbError = new Error('RPC failed');
      mockDataAccess.Token.findBySiteIdAndTokenType.rejects(dbError);

      const context = {
        params: { siteId, tokenType: 'monthly_suggestion_cwv' },
        log: { error: sinon.stub() },
      };

      const result = await tokensController.getByTokenType(context);

      expect(result.status).to.equal(500);
      const body = await result.json();
      expect(body.message).to.equal('RPC failed');
      expect(context.log.error).to.have.been.calledWith(
        `Error getting token by type monthly_suggestion_cwv for site ${siteId}: RPC failed`,
      );
    });
  });

  describe('getGrants', () => {
    const grantId1 = '323e4567-e89b-12d3-a456-426614174002';
    const grantId2 = '423e4567-e89b-12d3-a456-426614174003';
    const suggestionId1 = '523e4567-e89b-12d3-a456-426614174004';
    const suggestionId2 = '623e4567-e89b-12d3-a456-426614174005';

    const mockGrant = (grantId, suggestionId) => ({
      getId: () => `id-${grantId}`,
      getGrantId: () => grantId,
      getSuggestionId: () => suggestionId,
      getSiteId: () => siteId,
      getTokenId: () => tokenId,
      getTokenType: () => 'grant_cwv',
      getGrantedAt: () => '2025-03-01T00:00:00Z',
    });

    beforeEach(() => {
      mockDataAccess.Token.findById = sandbox.stub().resolves(mockToken);
      mockDataAccess.SuggestionGrant = {
        allByIndexKeys: sandbox.stub().resolves([
          mockGrant(grantId1, suggestionId1),
          mockGrant(grantId2, suggestionId2),
        ]),
      };

      tokensController = TokensController({
        dataAccess: mockDataAccess,
        attributes: {
          authInfo: new AuthInfo()
            .withType('jwt')
            .withProfile({ is_admin: true })
            .withAuthenticated(true),
        },
      });
    });

    it('returns grants with suggestionId for a valid token', async () => {
      const context = {
        params: { siteId, tokenId },
        log: { error: sinon.stub() },
      };

      const result = await tokensController.getGrants(context);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body).to.have.lengthOf(2);
      expect(body[0]).to.deep.equal({
        id: `id-${grantId1}`,
        grantId: grantId1,
        suggestionId: suggestionId1,
        siteId,
        tokenId,
        tokenType: 'grant_cwv',
        grantedAt: '2025-03-01T00:00:00Z',
      });
      expect(mockDataAccess.SuggestionGrant.allByIndexKeys)
        .to.have.been.calledOnceWith({ tokenId });
    });

    it('returns empty array when no grants exist', async () => {
      mockDataAccess.SuggestionGrant.allByIndexKeys.resolves([]);
      const context = {
        params: { siteId, tokenId },
        log: { error: sinon.stub() },
      };

      const result = await tokensController.getGrants(context);

      expect(result.status).to.equal(200);
      const body = await result.json();
      expect(body).to.deep.equal([]);
    });

    it('returns 400 for invalid site ID', async () => {
      const result = await tokensController.getGrants({
        params: { siteId: 'bad', tokenId },
      });
      expect(result.status).to.equal(400);
      expect((await result.json()).message).to.equal('Site ID required');
    });

    it('returns 400 for invalid token ID', async () => {
      const result = await tokensController.getGrants({
        params: { siteId, tokenId: 'bad' },
      });
      expect(result.status).to.equal(400);
      expect((await result.json()).message).to.equal('Token ID required');
    });

    it('returns 404 when site is not found', async () => {
      mockDataAccess.Site.findById.resolves(null);
      const context = {
        params: { siteId, tokenId },
        log: { error: sinon.stub() },
      };
      const result = await tokensController.getGrants(context);
      expect(result.status).to.equal(404);
      expect((await result.json()).message).to.equal('Site not found');
    });

    it('returns 403 when user lacks access', async () => {
      mockAccessControlUtil.hasAccess.resolves(false);
      const context = {
        params: { siteId, tokenId },
        log: { error: sinon.stub() },
      };
      const result = await tokensController.getGrants(context);
      expect(result.status).to.equal(403);
      expect((await result.json()).message).to.equal('Access denied to this site');
    });

    it('returns 404 when token is not found', async () => {
      mockDataAccess.Token.findById.resolves(null);
      const context = {
        params: { siteId, tokenId },
        log: { error: sinon.stub() },
      };
      const result = await tokensController.getGrants(context);
      expect(result.status).to.equal(404);
      expect((await result.json()).message).to.equal('Token not found');
    });

    it('returns 404 when token belongs to a different site', async () => {
      mockDataAccess.Token.findById.resolves({
        ...mockToken,
        getSiteId: () => 'different-site-id',
      });
      const context = {
        params: { siteId, tokenId },
        log: { error: sinon.stub() },
      };
      const result = await tokensController.getGrants(context);
      expect(result.status).to.equal(404);
      expect((await result.json()).message).to.equal('Token not found');
    });

    it('returns 500 on unexpected error', async () => {
      mockDataAccess.SuggestionGrant.allByIndexKeys.rejects(new Error('DB failure'));
      const context = {
        params: { siteId, tokenId },
        log: { error: sinon.stub() },
      };
      const result = await tokensController.getGrants(context);
      expect(result.status).to.equal(500);
      expect((await result.json()).message).to.equal('DB failure');
      expect(context.log.error).to.have.been.calledWith(
        `Error getting grants for token ${tokenId} on site ${siteId}: DB failure`,
      );
    });
  });
});
