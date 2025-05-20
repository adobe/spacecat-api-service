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

import FileController from '../../src/controllers/file.js';
import AccessControlUtil from '../../src/support/access-control-util.js';

describe('FileController', () => {
  let sandbox;
  let mockContext;
  let fileController;
  let requestContext;
  let mockDataAccess;
  let mockAccessControlUtil;

  beforeEach(() => {
    sandbox = sinon.createSandbox();

    mockDataAccess = {
      Site: {
        findById: sandbox.stub().resolves({ id: 'test-site-id' }),
      },
    };

    mockAccessControlUtil = {
      hasAccess: sandbox.stub().resolves(true),
    };

    sandbox.stub(AccessControlUtil, 'fromContext').returns(mockAccessControlUtil);

    mockContext = {
      s3: {
        s3Client: {
          send: sandbox.stub(),
        },
        GetObjectCommand: sandbox.stub(),
        getSignedUrl: sandbox.stub(),
      },
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
          .withScopes([{ name: 'admin' }])
          .withProfile({ is_admin: true })
          .withAuthenticated(true),
      },
    };

    fileController = FileController(mockContext);
    requestContext = {
      params: {
        siteId: 'test-site-id',
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
      expect(() => FileController()).to.throw('Context required');
    });
  });

  describe('getFileByKey', () => {
    it('should return a found response with a pre-signed URL', async () => {
      const presignedUrl = 'https://test-bucket.s3.amazonaws.com/test/path/file.txt?signed=true';
      mockContext.s3.getSignedUrl.resolves(presignedUrl);

      const response = await fileController.getFileByKey(requestContext);

      expect(response.status).to.equal(302);
      expect(response.headers.get('Location')).to.equal(presignedUrl);

      expect(mockContext.s3.GetObjectCommand).to.have.been.calledOnce;
      expect(mockContext.s3.GetObjectCommand).to.have.been.calledWith({
        Bucket: 'test-bucket',
        Key: 'test/path/file.txt',
      });
    });

    it('should throw 400 error when key is missing', async () => {
      requestContext.data.key = null;

      try {
        await fileController.getFileByKey(requestContext);
        expect.fail('Should have thrown an error');
      } catch (err) {
        expect(err.message).to.equal('File key is required');
        expect(err.status).to.equal(400);
      }
    });

    it('should throw 404 error when site is not found', async () => {
      mockContext.dataAccess.Site.findById.resolves(null);

      const response = await fileController.getFileByKey(requestContext);
      expect(response.status).to.equal(404);
      const error = await response.json();
      expect(error.message).to.equal('Site not found');
    });

    it('should throw 403 error when user has no access to site', async () => {
      mockAccessControlUtil.hasAccess.resolves(false);

      const response = await fileController.getFileByKey(requestContext);
      expect(response.status).to.equal(403);
      const error = await response.json();
      expect(error.message).to.equal('Only users belonging to the organization can get files');
    });

    it('should throw 404 error when file does not exist', async () => {
      const error = new Error('File not found');
      error.name = 'NoSuchKey';
      mockContext.s3.getSignedUrl.rejects(error);

      try {
        await fileController.getFileByKey(requestContext);
        expect.fail('Should have thrown an error');
      } catch (err) {
        expect(err.message).to.equal('File not found');
        expect(err.status).to.equal(404);
      }

      expect(mockContext.log.error).to.have.been.calledOnce;
    });

    it('should throw 500 error on unexpected errors', async () => {
      mockContext.s3.getSignedUrl.rejects(new Error('Unexpected error'));

      try {
        await fileController.getFileByKey(requestContext);
        expect.fail('Should have thrown an error');
      } catch (err) {
        expect(err.message).to.equal('Error occurred generating a pre-signed URL');
        expect(err.status).to.equal(500);
      }

      expect(mockContext.log.error).to.have.been.calledOnce;
    });
  });
});
