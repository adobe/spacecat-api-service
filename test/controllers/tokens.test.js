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
});
