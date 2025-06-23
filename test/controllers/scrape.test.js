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

import { expect } from 'chai';
import sinon from 'sinon';
import AuthInfo from '@adobe/spacecat-shared-http-utils/src/auth/auth-info.js';

import ScrapeController from '../../src/controllers/scrape.js';
import AccessControlUtil from '../../src/support/access-control-util.js';

const TEST_SITE = {
  id: '0b4dcf79-fe5f-410b-b11f-641f0bf56da3',
  name: 'Test Site',
};

const TEST_FILE = {
  Key: 'scrapes/0b4dcf79-fe5f-410b-b11f-641f0bf56da3/foo/file1.txt',
  Size: 123,
  LastModified: '2024-01-01T00:00:00.000Z',
};

const TEST_FILE_RESPONSE = {
  name: 'file1.txt',
  type: 'txt',
  size: 123,
  lastModified: '2024-01-01T00:00:00.000Z',
  key: 'scrapes/0b4dcf79-fe5f-410b-b11f-641f0bf56da3/foo/file1.txt',
};

describe('ScrapeController', () => {
  let sandbox;
  let mockContext;
  let scrapeController;
  let requestContext;
  let mockDataAccess;
  let mockAccessControlUtil;
  let mockS3;

  beforeEach(() => {
    sandbox = sinon.createSandbox();

    mockDataAccess = {
      Site: {
        findById: sandbox.stub().resolves(TEST_SITE),
      },
    };

    mockAccessControlUtil = {
      hasAccess: sandbox.stub().resolves(true),
    };

    mockS3 = {
      s3Client: {
        send: sandbox.stub(),
      },
      GetObjectCommand: sandbox.stub(),
      ListObjectsV2Command: sandbox.stub().callsFake((params) => ({ input: params })),
      getSignedUrl: sandbox.stub(),
    };

    sandbox.stub(AccessControlUtil, 'fromContext').returns(mockAccessControlUtil);

    mockContext = {
      s3: mockS3,
      log: {
        info: sandbox.stub(),
        error: sandbox.stub(),
      },
      env: {
        S3_SCRAPER_BUCKET: 'test-bucket',
      },
      dataAccess: mockDataAccess,
      attributes: {
        authInfo: new AuthInfo()
          .withType('jwt')
          .withProfile({ is_admin: true })
          .withAuthenticated(true),
      },
    };

    scrapeController = ScrapeController(mockContext);
    requestContext = {
      params: {
        siteId: TEST_SITE.id,
      },
      data: {
        key: 'test/path/file.txt',
      },
      dataAccess: mockDataAccess,
      attributes: {
        authInfo: new AuthInfo()
          .withType('jwt')
          .withScopes([{ name: 'admin' }])
          .withProfile({ is_admin: true })
          .withAuthenticated(true),
      },
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('constructor', () => {
    it('should throw error when context is missing', () => {
      expect(() => ScrapeController()).to.throw('Context required');
    });
  });

  describe('getFileByKey', () => {
    it('should return a found response with a pre-signed URL', async () => {
      const presignedUrl = 'https://test-bucket.s3.amazonaws.com/test/path/file.txt?signed=true';
      mockS3.getSignedUrl.resolves(presignedUrl);

      const response = await scrapeController.getFileByKey(requestContext);

      expect(response.status).to.equal(302);
      expect(response.headers.get('Location')).to.equal(presignedUrl);
      expect(mockS3.GetObjectCommand).to.have.been.calledWith({
        Bucket: 'test-bucket',
        Key: 'test/path/file.txt',
      });
    });

    it('should throw 400 error when key is missing', async () => {
      requestContext.data.key = null;

      try {
        await scrapeController.getFileByKey(requestContext);
        expect.fail('Should have thrown an error');
      } catch (err) {
        expect(err.message).to.equal('File key is required');
        expect(err.status).to.equal(400);
      }
    });

    it('should throw 404 error when site is not found', async () => {
      mockDataAccess.Site.findById.resolves(null);

      const response = await scrapeController.getFileByKey(requestContext);
      expect(response.status).to.equal(404);
      const error = await response.json();
      expect(error.message).to.equal('Site not found');
    });

    it('should throw 403 error when user has no access to site', async () => {
      mockAccessControlUtil.hasAccess.resolves(false);

      const response = await scrapeController.getFileByKey(requestContext);
      expect(response.status).to.equal(403);
      const error = await response.json();
      expect(error.message).to.equal('Only users belonging to the organization can get files');
    });

    it('should throw 404 error when file does not exist', async () => {
      const error = new Error('File not found');
      error.name = 'NoSuchKey';
      mockS3.getSignedUrl.rejects(error);

      try {
        await scrapeController.getFileByKey(requestContext);
        expect.fail('Should have thrown an error');
      } catch (err) {
        expect(err.message).to.equal('File not found');
        expect(err.status).to.equal(404);
      }

      expect(mockContext.log.error).to.have.been.calledOnce;
    });

    it('should throw 500 error on unexpected errors', async () => {
      mockS3.getSignedUrl.rejects(new Error('Unexpected error'));

      try {
        await scrapeController.getFileByKey(requestContext);
        expect.fail('Should have thrown an error');
      } catch (err) {
        expect(err.message).to.equal('Error occurred generating a pre-signed URL');
        expect(err.status).to.equal(500);
      }

      expect(mockContext.log.error).to.have.been.calledOnce;
    });
  });

  describe('listScrapedContentFiles', () => {
    const testCases = [
      {
        name: 'rootOnly true',
        data: { rootOnly: 'true' },
        expectedParams: { Delimiter: '/' },
      },
      {
        name: 'rootOnly false',
        data: {},
        expectedParams: {},
        checkParams: (params) => {
          expect(params).to.not.have.property('Delimiter');
        },
      },
      {
        name: 'with pageToken',
        data: { pageToken: 'abc123' },
        expectedParams: { ContinuationToken: 'abc123' },
      },
      {
        name: 'with path',
        data: { path: 'some/path' },
        expectedParams: {},
        checkPrefix: (prefix) => expect(prefix).to.equal(`scrapes/${TEST_SITE.id}/some/path/`),
      },
    ];

    beforeEach(() => {
      mockS3.s3Client.send.resolves({
        Contents: [TEST_FILE],
        NextContinuationToken: 'next-token',
      });
    });

    it('returns files with presigned URLs and nextPageToken', async () => {
      const response = await scrapeController.listScrapedContentFiles({
        ...requestContext,
        params: { ...requestContext.params, type: 'scrapes' },
        data: { path: 'foo/' },
      });

      const data = await response.json();
      expect(response.status).to.equal(200);
      expect(data).to.have.property('items').that.deep.equals([TEST_FILE_RESPONSE]);
      expect(data).to.have.property('nextPageToken', 'next-token');
    });

    it('returns 404 when site is not found', async () => {
      mockDataAccess.Site.findById.resolves(null);
      const response = await scrapeController.listScrapedContentFiles({
        ...requestContext,
        params: { ...requestContext.params, type: 'scrapes' },
      });

      expect(response.status).to.equal(404);
      const error = await response.json();
      expect(error.message).to.equal('Site not found');
    });

    it('returns 403 when user has no access to site', async () => {
      mockAccessControlUtil.hasAccess.resolves(false);
      const response = await scrapeController.listScrapedContentFiles({
        ...requestContext,
        params: { ...requestContext.params, type: 'scrapes' },
      });

      expect(response.status).to.equal(403);
      const error = await response.json();
      expect(error.message).to.equal('Only users belonging to the organization can get scraped content files');
    });

    it('handles validation errors', async () => {
      // Test missing siteId
      let response = await scrapeController.listScrapedContentFiles({
        ...requestContext,
        params: { type: 'scrapes' },
      });
      expect(response.status).to.equal(400);
      let error = await response.json();
      expect(error).to.have.property('message', 'Site ID required');

      // Test invalid type
      response = await scrapeController.listScrapedContentFiles({
        ...requestContext,
        params: { siteId: TEST_SITE.id, type: 'invalid' },
      });
      error = await response.json();
      expect(error).to.have.property('message').that.includes('Type must be either');
    });

    it('handles empty responses and errors', async () => {
      // Test empty response
      mockS3.s3Client.send.resolves({ Contents: [], NextContinuationToken: undefined });
      let response = await scrapeController.listScrapedContentFiles({
        ...requestContext,
        params: { ...requestContext.params, type: 'scrapes' },
      });
      let data = await response.json();
      expect(data).to.deep.equal({ items: [], nextPageToken: null });

      // Test undefined Contents
      mockS3.s3Client.send.resolves({ NextContinuationToken: undefined });
      response = await scrapeController.listScrapedContentFiles({
        ...requestContext,
        params: { ...requestContext.params, type: 'scrapes' },
      });
      data = await response.json();
      expect(data).to.deep.equal({ items: [], nextPageToken: null });

      // Test S3 error
      mockS3.s3Client.send.rejects(new Error('S3 error'));
      await expect(scrapeController.listScrapedContentFiles({
        ...requestContext,
        params: { ...requestContext.params, type: 'scrapes' },
      })).to.be.rejectedWith('S3 error');
    });

    it('handles S3 parameter variations', async () => {
      for (const testCase of testCases) {
        // Reset the mock before each test case
        mockS3.s3Client.send.reset();
        mockS3.s3Client.send.resolves({
          Contents: [TEST_FILE],
          NextContinuationToken: 'next-token',
        });

        // eslint-disable-next-line no-await-in-loop
        const response = await scrapeController.listScrapedContentFiles({
          ...requestContext,
          params: { ...requestContext.params, type: 'scrapes' },
          data: testCase.data,
        });

        expect(response.status).to.equal(200);
        // eslint-disable-next-line no-await-in-loop
        const data = await response.json();
        expect(data).to.have.property('items');

        // Verify S3 parameters
        const s3Call = mockS3.s3Client.send.getCall(0);
        const params = s3Call.args[0].input;
        // Check expected parameters
        const expectedParams = testCase.expectedParams || {};
        for (const [key, value] of Object.entries(expectedParams)) {
          expect(params).to.have.property(key, value);
        }

        if (testCase.checkParams) {
          testCase.checkParams(params);
        }

        if (testCase.checkPrefix) {
          testCase.checkPrefix(params.Prefix);
        }
      }
    });

    it('handles undefined context.params', async () => {
      const response = await scrapeController.listScrapedContentFiles({
        ...requestContext,
        params: undefined,
      });

      expect(response.status).to.equal(400);
      const error = await response.json();
      expect(error).to.have.property('message', 'Site ID required');
    });

    it('handles context.data undefined (should default to empty object and path to empty string)', async () => {
      mockS3.s3Client.send.reset();
      mockS3.s3Client.send.resolves({
        Contents: [TEST_FILE],
        NextContinuationToken: 'next-token',
      });
      const response = await scrapeController.listScrapedContentFiles({
        ...requestContext,
        params: { ...requestContext.params, type: 'scrapes' },
        data: undefined,
      });
      const data = await response.json();
      expect(response.status).to.equal(200);
      expect(data).to.have.property('items');
      const s3Call = mockS3.s3Client.send.getCall(0);
      expect(s3Call.args[0].input.Prefix).to.equal(`scrapes/${TEST_SITE.id}/`);
    });

    it('handles context.data present but path undefined (should default path to empty string)', async () => {
      mockS3.s3Client.send.reset();
      mockS3.s3Client.send.resolves({
        Contents: [TEST_FILE],
        NextContinuationToken: 'next-token',
      });
      const response = await scrapeController.listScrapedContentFiles({
        ...requestContext,
        params: { ...requestContext.params, type: 'scrapes' },
        data: {},
      });
      const data = await response.json();
      expect(response.status).to.equal(200);
      expect(data).to.have.property('items');
      const s3Call = mockS3.s3Client.send.getCall(0);
      expect(s3Call.args[0].input.Prefix).to.equal(`scrapes/${TEST_SITE.id}/`);
    });
  });
});
