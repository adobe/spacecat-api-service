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

import { expect } from 'chai';
import sinon from 'sinon';

import RedirectsController from '../../src/controllers/redirects.js';

const API_KEY = 'super-secret-aso-key';
const BUCKET = 'spacecat-dev-aso-overlays';
const SERVICE = 'cm-p154709-e1629980';

describe('RedirectsController', () => {
  let sandbox;
  let mockS3;
  let mockContext;
  let controller;
  let requestContext;

  beforeEach(() => {
    sandbox = sinon.createSandbox();

    mockS3 = {
      s3Client: { send: sandbox.stub() },
      GetObjectCommand: sandbox.stub().callsFake((params) => ({ input: params })),
    };

    mockContext = {
      s3: mockS3,
      log: { info: sandbox.stub(), error: sandbox.stub() },
      env: { S3_ASO_OVERLAYS_BUCKET: BUCKET, ASO_OVERLAY_API_KEY: API_KEY },
    };

    controller = RedirectsController(mockContext);
    requestContext = {
      params: { env: 'dev', service: SERVICE },
      pathInfo: { headers: { 'x-aso-api-key': API_KEY } },
    };
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('throws when constructed without a context', () => {
    expect(() => RedirectsController()).to.throw('Context required');
  });

  it('returns 200 text/plain with the overlay body for a valid request', async () => {
    const overlay = 'example.com/old https://www.example.com/new\n';
    mockS3.s3Client.send.resolves({
      Body: { transformToString: sandbox.stub().resolves(overlay) },
    });

    const response = await controller.getRedirects(requestContext);

    expect(response.status).to.equal(200);
    expect(response.headers.get('content-type')).to.equal('text/plain; charset=utf-8');
    expect(await response.text()).to.equal(overlay);
    // Reads the env-stripped key from the configured overlays bucket.
    expect(mockS3.GetObjectCommand.calledWithMatch({
      Bucket: BUCKET,
      Key: `config/${SERVICE}/redirects.txt`,
    })).to.be.true;
  });

  it('returns 401 when the X-ASO-API-Key header is missing', async () => {
    requestContext.pathInfo.headers = {};
    const response = await controller.getRedirects(requestContext);
    expect(response.status).to.equal(401);
    expect(mockS3.s3Client.send.called).to.be.false;
  });

  it('returns 401 when the X-ASO-API-Key is wrong', async () => {
    requestContext.pathInfo.headers['x-aso-api-key'] = 'wrong-key';
    const response = await controller.getRedirects(requestContext);
    expect(response.status).to.equal(401);
  });

  it('returns 400 for an invalid environment segment', async () => {
    requestContext.params.env = 'qa';
    const response = await controller.getRedirects(requestContext);
    expect(response.status).to.equal(400);
  });

  it('returns 400 for a malformed service identifier', async () => {
    requestContext.params.service = 'not-a-cm-service';
    const response = await controller.getRedirects(requestContext);
    expect(response.status).to.equal(400);
  });

  it('returns 404 when the overlay object does not exist', async () => {
    const err = new Error('not found');
    err.name = 'NoSuchKey';
    mockS3.s3Client.send.rejects(err);

    const response = await controller.getRedirects(requestContext);
    expect(response.status).to.equal(404);
  });

  it('returns 404 when S3 surfaces a 404 via $metadata', async () => {
    const err = new Error('not found');
    err.$metadata = { httpStatusCode: 404 };
    mockS3.s3Client.send.rejects(err);

    const response = await controller.getRedirects(requestContext);
    expect(response.status).to.equal(404);
  });

  it('returns 404 when the requested env does not match the deployment bucket', async () => {
    // Bucket is spacecat-dev-aso-overlays; a request for prod must not be served.
    requestContext.params.env = 'prod';
    const response = await controller.getRedirects(requestContext);
    expect(response.status).to.equal(404);
    expect(mockS3.s3Client.send.called).to.be.false;
  });

  it('returns 500 on an unexpected S3 error', async () => {
    mockS3.s3Client.send.rejects(new Error('boom'));
    const response = await controller.getRedirects(requestContext);
    expect(response.status).to.equal(500);
    expect(mockContext.log.error.called).to.be.true;
  });

  it('returns 500 when the API key is not configured', async () => {
    const ctl = RedirectsController({
      ...mockContext,
      env: { S3_ASO_OVERLAYS_BUCKET: BUCKET },
    });
    const response = await ctl.getRedirects(requestContext);
    expect(response.status).to.equal(500);
  });

  it('returns 500 when the overlays bucket is not configured', async () => {
    const ctl = RedirectsController({ ...mockContext, env: { ASO_OVERLAY_API_KEY: API_KEY } });
    const response = await ctl.getRedirects(requestContext);
    expect(response.status).to.equal(500);
  });
});
