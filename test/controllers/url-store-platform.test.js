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

/* eslint-env mocha */

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import { PLATFORM_TYPES } from '@adobe/spacecat-shared-data-access';
import UrlStoreController from '../../src/controllers/url-store.js';

use(chaiAsPromised);
use(sinonChai);

describe('URL Store Controller - Platform Type Support', () => {
  const sandbox = sinon.createSandbox();

  const mockLogger = {
    info: sandbox.stub(),
    error: sandbox.stub(),
    warn: sandbox.stub(),
    debug: sandbox.stub(),
  };

  const mockDataAccess = {
    AuditUrl: {
      allBySiteIdAndPlatform: sandbox.stub(),
      allOffsiteUrls: sandbox.stub(),
      findBySiteIdAndUrl: sandbox.stub(),
      create: sandbox.stub(),
    },
  };

  let controller;

  beforeEach(() => {
    controller = UrlStoreController({ dataAccess: mockDataAccess, log: mockLogger });
  });

  afterEach(() => {
    sandbox.reset();
  });

  describe('listUrlsByPlatform', () => {
    it('returns URLs for a specific platform type', async () => {
      const mockUrl1 = {
        getUrl: () => 'https://www.youtube.com/@example',
        getPlatformType: () => 'youtube-channel',
        getTraffic: () => 1000000,
        toJSON: () => ({
          url: 'https://www.youtube.com/@example',
          platformType: 'youtube-channel',
          traffic: 1000000,
        }),
      };

      const mockUrl2 = {
        getUrl: () => 'https://www.youtube.com/@example2',
        getPlatformType: () => 'youtube-channel',
        getTraffic: () => 500000,
        toJSON: () => ({
          url: 'https://www.youtube.com/@example2',
          platformType: 'youtube-channel',
          traffic: 500000,
        }),
      };

      mockDataAccess.AuditUrl.allBySiteIdAndPlatform.resolves({
        items: [mockUrl1, mockUrl2],
      });

      const context = {
        pathInfo: {
          suffix: '/sites/site123/url-store/by-platform/youtube-channel',
        },
        params: {
          siteId: 'site123',
          platformType: 'youtube-channel',
        },
        data: {},
      };

      const response = await controller.listUrlsByPlatform(context);

      expect(response.status).to.equal(200);
      expect(response.body).to.be.an('object');
      expect(response.body.items).to.be.an('array').with.lengthOf(2);
      expect(response.body.items[0].platformType).to.equal('youtube-channel');
      expect(mockDataAccess.AuditUrl.allBySiteIdAndPlatform).to.have.been.calledOnceWith(
        'site123',
        'youtube-channel',
        {},
      );
    });

    it('supports sorting by traffic', async () => {
      mockDataAccess.AuditUrl.allBySiteIdAndPlatform.resolves({ items: [] });

      const context = {
        pathInfo: {
          suffix: '/sites/site123/url-store/by-platform/youtube-channel',
        },
        params: {
          siteId: 'site123',
          platformType: 'youtube-channel',
        },
        data: {
          sortBy: 'traffic',
          sortOrder: 'desc',
        },
      };

      await controller.listUrlsByPlatform(context);

      expect(mockDataAccess.AuditUrl.allBySiteIdAndPlatform).to.have.been.calledOnceWith(
        'site123',
        'youtube-channel',
        { sortBy: 'traffic', sortOrder: 'desc' },
      );
    });

    it('supports pagination', async () => {
      mockDataAccess.AuditUrl.allBySiteIdAndPlatform.resolves({
        items: [],
        cursor: 'next-page-cursor',
      });

      const context = {
        pathInfo: {
          suffix: '/sites/site123/url-store/by-platform/wikipedia',
        },
        params: {
          siteId: 'site123',
          platformType: 'wikipedia',
        },
        data: {
          limit: 10,
          cursor: 'page-cursor',
        },
      };

      const response = await controller.listUrlsByPlatform(context);

      expect(response.status).to.equal(200);
      expect(response.body.cursor).to.equal('next-page-cursor');
      expect(mockDataAccess.AuditUrl.allBySiteIdAndPlatform).to.have.been.calledOnceWith(
        'site123',
        'wikipedia',
        { limit: 10, cursor: 'page-cursor' },
      );
    });

    it('returns 400 for invalid platform type', async () => {
      const context = {
        pathInfo: {
          suffix: '/sites/site123/url-store/by-platform/invalid-platform',
        },
        params: {
          siteId: 'site123',
          platformType: 'invalid-platform',
        },
        data: {},
      };

      const response = await controller.listUrlsByPlatform(context);

      expect(response.status).to.equal(400);
      expect(response.body.message).to.include('Invalid platformType');
      expect(mockDataAccess.AuditUrl.allBySiteIdAndPlatform).to.not.have.been.called;
    });
  });

  describe('listOffsiteUrls', () => {
    it('returns all offsite platform URLs', async () => {
      const mockWikiUrl = {
        getUrl: () => 'https://en.wikipedia.org/wiki/Example',
        getPlatformType: () => 'wikipedia',
        toJSON: () => ({
          url: 'https://en.wikipedia.org/wiki/Example',
          platformType: 'wikipedia',
        }),
      };

      const mockYoutubeUrl = {
        getUrl: () => 'https://www.youtube.com/@example',
        getPlatformType: () => 'youtube-channel',
        toJSON: () => ({
          url: 'https://www.youtube.com/@example',
          platformType: 'youtube-channel',
        }),
      };

      mockDataAccess.AuditUrl.allOffsiteUrls.resolves({
        items: [mockWikiUrl, mockYoutubeUrl],
      });

      const context = {
        pathInfo: {
          suffix: '/sites/site123/url-store/offsite',
        },
        params: {
          siteId: 'site123',
        },
        data: {},
      };

      const response = await controller.listOffsiteUrls(context);

      expect(response.status).to.equal(200);
      expect(response.body).to.be.an('object');
      expect(response.body.items).to.be.an('array').with.lengthOf(2);
      expect(mockDataAccess.AuditUrl.allOffsiteUrls).to.have.been.calledOnceWith(
        'site123',
        {},
      );
    });

    it('supports sorting by rank', async () => {
      mockDataAccess.AuditUrl.allOffsiteUrls.resolves({ items: [] });

      const context = {
        pathInfo: {
          suffix: '/sites/site123/url-store/offsite',
        },
        params: {
          siteId: 'site123',
        },
        data: {
          sortBy: 'rank',
          sortOrder: 'asc',
        },
      };

      await controller.listOffsiteUrls(context);

      expect(mockDataAccess.AuditUrl.allOffsiteUrls).to.have.been.calledOnceWith(
        'site123',
        { sortBy: 'rank', sortOrder: 'asc' },
      );
    });

    it('supports pagination', async () => {
      mockDataAccess.AuditUrl.allOffsiteUrls.resolves({
        items: [],
        cursor: 'next-cursor',
      });

      const context = {
        pathInfo: {
          suffix: '/sites/site123/url-store/offsite',
        },
        params: {
          siteId: 'site123',
        },
        data: {
          limit: 20,
          cursor: 'current-cursor',
        },
      };

      const response = await controller.listOffsiteUrls(context);

      expect(response.status).to.equal(200);
      expect(response.body.cursor).to.equal('next-cursor');
      expect(mockDataAccess.AuditUrl.allOffsiteUrls).to.have.been.calledOnceWith(
        'site123',
        { limit: 20, cursor: 'current-cursor' },
      );
    });
  });

  describe('addUrls - platformType handling', () => {
    it('accepts valid platformType in URL payload', async () => {
      mockDataAccess.AuditUrl.findBySiteIdAndUrl.resolves(null);
      mockDataAccess.AuditUrl.create.resolves({
        getUrl: () => 'https://www.youtube.com/@example',
        getPlatformType: () => 'youtube-channel',
        toJSON: () => ({
          url: 'https://www.youtube.com/@example',
          platformType: 'youtube-channel',
        }),
      });

      const context = {
        pathInfo: {
          suffix: '/sites/site123/url-store',
        },
        params: {
          siteId: 'site123',
        },
        data: {
          urls: [
            {
              url: 'https://www.youtube.com/@example',
              platformType: 'youtube-channel',
              audits: ['broken-backlinks'],
            },
          ],
        },
        attributes: {
          authInfo: {
            getProfile: () => ({ email: 'user@example.com' }),
          },
        },
      };

      const response = await controller.addUrls(context);

      expect(response.status).to.equal(207);
      expect(mockDataAccess.AuditUrl.create).to.have.been.calledOnce;
      const createCall = mockDataAccess.AuditUrl.create.getCall(0);
      expect(createCall.args[0].platformType).to.equal('youtube-channel');
    });

    it('defaults to primary-site when platformType not provided', async () => {
      mockDataAccess.AuditUrl.findBySiteIdAndUrl.resolves(null);
      mockDataAccess.AuditUrl.create.resolves({
        getUrl: () => 'https://example.com/page',
        getPlatformType: () => 'primary-site',
        toJSON: () => ({
          url: 'https://example.com/page',
          platformType: 'primary-site',
        }),
      });

      const context = {
        pathInfo: {
          suffix: '/sites/site123/url-store',
        },
        params: {
          siteId: 'site123',
        },
        data: {
          urls: [
            {
              url: 'https://example.com/page',
              audits: ['broken-backlinks'],
            },
          ],
        },
        attributes: {
          authInfo: {
            getProfile: () => ({ email: 'user@example.com' }),
          },
        },
      };

      const response = await controller.addUrls(context);

      expect(response.status).to.equal(207);
      expect(mockDataAccess.AuditUrl.create).to.have.been.calledOnce;
      const createCall = mockDataAccess.AuditUrl.create.getCall(0);
      expect(createCall.args[0].platformType).to.equal('primary-site');
    });

    it('rejects invalid platformType', async () => {
      const context = {
        pathInfo: {
          suffix: '/sites/site123/url-store',
        },
        params: {
          siteId: 'site123',
        },
        data: {
          urls: [
            {
              url: 'https://example.com/page',
              platformType: 'invalid-platform-type',
              audits: [],
            },
          ],
        },
        attributes: {
          authInfo: {
            getProfile: () => ({ email: 'user@example.com' }),
          },
        },
      };

      const response = await controller.addUrls(context);

      expect(response.status).to.equal(207);
      expect(response.body.results[0].success).to.be.false;
      expect(response.body.results[0].reason).to.include('Invalid platformType');
      expect(mockDataAccess.AuditUrl.create).to.not.have.been.called;
    });
  });

  describe('PLATFORM_TYPES constant', () => {
    it('is exported from data access layer', () => {
      expect(PLATFORM_TYPES).to.be.an('object');
      expect(PLATFORM_TYPES.PRIMARY_SITE).to.equal('primary-site');
      expect(PLATFORM_TYPES.WIKIPEDIA).to.equal('wikipedia');
      expect(PLATFORM_TYPES.YOUTUBE_CHANNEL).to.equal('youtube-channel');
      expect(PLATFORM_TYPES.REDDIT_COMMUNITY).to.equal('reddit-community');
      expect(PLATFORM_TYPES.FACEBOOK_PAGE).to.equal('facebook-page');
      expect(PLATFORM_TYPES.TWITTER_PROFILE).to.equal('twitter-profile');
      expect(PLATFORM_TYPES.LINKEDIN_COMPANY).to.equal('linkedin-company');
      expect(PLATFORM_TYPES.INSTAGRAM_ACCOUNT).to.equal('instagram-account');
      expect(PLATFORM_TYPES.TIKTOK_ACCOUNT).to.equal('tiktok-account');
      expect(PLATFORM_TYPES.GITHUB_ORG).to.equal('github-org');
      expect(PLATFORM_TYPES.MEDIUM_PUBLICATION).to.equal('medium-publication');
    });
  });
});
