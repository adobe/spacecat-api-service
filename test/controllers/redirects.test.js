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

const BUCKET = 'spacecat-dev-aso-overlays';
const SERVICE = 'cm-p154709-e1629980';
const ORG_ID = 'org-1';
const ENTITLEMENT_ID = 'ent-aso-1';
const ETAG = '"d41d8cd98f00b204e9800998ecf8427e"';

/**
 * Authentication for this route is performed upstream by AsoOverlayKeyHandler
 * (see test/support/aso-overlay-key-handler.test.js); by the time the controller
 * runs the request is already authenticated. These tests therefore exercise the
 * per-request AUTHORIZATION (resolve service -> entitled site) and S3 read.
 */
describe('RedirectsController', () => {
  let sandbox;
  let mockS3;
  let mockSite;
  let mockEntitlement;
  let mockDataAccess;
  let mockContext;
  let controller;
  let requestContext;

  beforeEach(() => {
    sandbox = sinon.createSandbox();

    mockS3 = {
      s3Client: { send: sandbox.stub() },
      GetObjectCommand: sandbox.stub().callsFake((params) => ({ input: params })),
    };

    mockSite = { getId: () => 'site-1', getOrganizationId: () => ORG_ID };
    mockEntitlement = { getId: () => ENTITLEMENT_ID };

    mockDataAccess = {
      Site: { findByExternalOwnerIdAndExternalSiteId: sandbox.stub().resolves(mockSite) },
      Entitlement: { findByOrganizationIdAndProductCode: sandbox.stub().resolves(mockEntitlement) },
      SiteEnrollment: {
        allBySiteId: sandbox.stub().resolves([
          { getEntitlementId: () => ENTITLEMENT_ID },
        ]),
      },
    };

    mockContext = {
      s3: mockS3,
      dataAccess: mockDataAccess,
      log: { info: sandbox.stub(), error: sandbox.stub() },
      env: { S3_ASO_OVERLAYS_BUCKET: BUCKET },
    };

    controller = RedirectsController(mockContext);
    requestContext = { params: { service: SERVICE } };
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('throws when constructed without a context', () => {
    expect(() => RedirectsController()).to.throw('Context required');
  });

  it('returns 200 text/plain with the overlay body for an entitled, enrolled site', async () => {
    const overlay = 'example.com/old https://www.example.com/new\n';
    mockS3.s3Client.send.resolves({
      ETag: ETAG,
      Body: { transformToString: sandbox.stub().resolves(overlay) },
    });

    const response = await controller.getRedirects(requestContext);

    expect(response.status).to.equal(200);
    expect(response.headers.get('content-type')).to.equal('text/plain; charset=utf-8');
    expect(response.headers.get('cache-control')).to.equal('max-age=10');
    expect(response.headers.get('etag')).to.equal(ETAG);
    expect(await response.text()).to.equal(overlay);
    // Resolves the site by the p<program>/e<env> external ids parsed from the service.
    expect(mockDataAccess.Site.findByExternalOwnerIdAndExternalSiteId
      .calledWith('p154709', 'e1629980')).to.be.true;
    // Reads the service-scoped key from the configured overlays bucket.
    expect(mockS3.GetObjectCommand.calledWithMatch({
      Bucket: BUCKET,
      Key: `config/${SERVICE}/redirects.txt`,
    })).to.be.true;
  });

  it('returns 200 without an ETag header when S3 does not surface one', async () => {
    // Defensive: S3 always returns ETag for a successful GET, but a future
    // storage backend might not — in that case we serve the body unconditionally.
    const overlay = 'example.com/old https://www.example.com/new\n';
    mockS3.s3Client.send.resolves({
      Body: { transformToString: sandbox.stub().resolves(overlay) },
    });

    const response = await controller.getRedirects(requestContext);

    expect(response.status).to.equal(200);
    expect(response.headers.get('etag')).to.be.null;
    expect(await response.text()).to.equal(overlay);
  });

  it('returns 304 with ETag + Cache-Control and no body when If-None-Match matches', async () => {
    const overlay = 'example.com/old https://www.example.com/new\n';
    const bodyStub = sandbox.stub().resolves(overlay);
    mockS3.s3Client.send.resolves({
      ETag: ETAG,
      Body: { transformToString: bodyStub },
    });
    requestContext.pathInfo = { headers: { 'If-None-Match': ETAG } };

    const response = await controller.getRedirects(requestContext);

    expect(response.status).to.equal(304);
    expect(response.headers.get('etag')).to.equal(ETAG);
    expect(response.headers.get('cache-control')).to.equal('max-age=10');
    expect(await response.text()).to.equal('');
    // Body never deserialized when returning 304 — saves the transformToString cost.
    expect(bodyStub.called).to.be.false;
  });

  it('accepts a lower-case if-none-match header (case-insensitive per HTTP)', async () => {
    mockS3.s3Client.send.resolves({
      ETag: ETAG,
      Body: { transformToString: sandbox.stub().resolves('') },
    });
    requestContext.pathInfo = { headers: { 'if-none-match': ETAG } };

    const response = await controller.getRedirects(requestContext);
    expect(response.status).to.equal(304);
  });

  it('returns 304 when If-None-Match: * and the resource exists', async () => {
    mockS3.s3Client.send.resolves({
      ETag: ETAG,
      Body: { transformToString: sandbox.stub().resolves('') },
    });
    requestContext.pathInfo = { headers: { 'if-none-match': '*' } };

    const response = await controller.getRedirects(requestContext);
    expect(response.status).to.equal(304);
  });

  it('returns 304 when If-None-Match is a multi-value list containing the current ETag', async () => {
    mockS3.s3Client.send.resolves({
      ETag: ETAG,
      Body: { transformToString: sandbox.stub().resolves('') },
    });
    requestContext.pathInfo = { headers: { 'if-none-match': `"other", ${ETAG}, "another"` } };

    const response = await controller.getRedirects(requestContext);
    expect(response.status).to.equal(304);
  });

  it('treats W/"tag" and "tag" as equivalent under RFC 7232 weak comparison', async () => {
    mockS3.s3Client.send.resolves({
      ETag: ETAG,
      Body: { transformToString: sandbox.stub().resolves('') },
    });
    requestContext.pathInfo = { headers: { 'if-none-match': `W/${ETAG}` } };

    const response = await controller.getRedirects(requestContext);
    expect(response.status).to.equal(304);
  });

  it('returns 200 with fresh body when If-None-Match does not match the current ETag', async () => {
    const overlay = 'example.com/new https://www.example.com/x\n';
    mockS3.s3Client.send.resolves({
      ETag: ETAG,
      Body: { transformToString: sandbox.stub().resolves(overlay) },
    });
    requestContext.pathInfo = { headers: { 'if-none-match': '"stale-etag"' } };

    const response = await controller.getRedirects(requestContext);
    expect(response.status).to.equal(200);
    expect(response.headers.get('etag')).to.equal(ETAG);
    expect(await response.text()).to.equal(overlay);
  });

  it('returns 200 when If-None-Match is empty/whitespace', async () => {
    const overlay = 'x y\n';
    mockS3.s3Client.send.resolves({
      ETag: ETAG,
      Body: { transformToString: sandbox.stub().resolves(overlay) },
    });
    requestContext.pathInfo = { headers: { 'if-none-match': '   ' } };

    const response = await controller.getRedirects(requestContext);
    expect(response.status).to.equal(200);
    expect(await response.text()).to.equal(overlay);
  });

  it('still returns 404 (not 304) when the site does not resolve — no enumeration signal via If-None-Match', async () => {
    // Guard: If-None-Match must not short-circuit authz. A non-entitled tenant
    // sending a valid ETag for some *other* tenant's overlay must still 404.
    mockDataAccess.Site.findByExternalOwnerIdAndExternalSiteId.resolves(null);
    requestContext.pathInfo = { headers: { 'if-none-match': ETAG } };

    const response = await controller.getRedirects(requestContext);
    expect(response.status).to.equal(404);
    // Authz failed before S3 was touched.
    expect(mockS3.s3Client.send.called).to.be.false;
  });

  it('still returns 404 (not 304) when If-None-Match: * is sent by a non-entitled tenant', async () => {
    mockDataAccess.Entitlement.findByOrganizationIdAndProductCode.resolves(null);
    requestContext.pathInfo = { headers: { 'if-none-match': '*' } };

    const response = await controller.getRedirects(requestContext);
    expect(response.status).to.equal(404);
    expect(mockS3.s3Client.send.called).to.be.false;
  });

  it('returns 400 for a malformed service identifier', async () => {
    requestContext.params.service = 'not-a-cm-service';
    const response = await controller.getRedirects(requestContext);
    expect(response.status).to.equal(400);
    expect(mockS3.s3Client.send.called).to.be.false;
  });

  it('returns 404 (not 403) when no site resolves — no enumeration signal', async () => {
    mockDataAccess.Site.findByExternalOwnerIdAndExternalSiteId.resolves(null);
    const response = await controller.getRedirects(requestContext);
    expect(response.status).to.equal(404);
    expect(mockS3.s3Client.send.called).to.be.false;
  });

  it('returns 404 when the site org holds no ASO entitlement', async () => {
    mockDataAccess.Entitlement.findByOrganizationIdAndProductCode.resolves(null);
    const response = await controller.getRedirects(requestContext);
    expect(response.status).to.equal(404);
    expect(mockS3.s3Client.send.called).to.be.false;
  });

  it('returns 404 when the site is not enrolled in the ASO entitlement', async () => {
    mockDataAccess.SiteEnrollment.allBySiteId.resolves([
      { getEntitlementId: () => 'some-other-entitlement' },
    ]);
    const response = await controller.getRedirects(requestContext);
    expect(response.status).to.equal(404);
    expect(mockS3.s3Client.send.called).to.be.false;
  });

  it('returns 404 when the overlay object does not exist (NoSuchKey)', async () => {
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

  it('maps AccessDenied (no ListBucket → 403 on missing key) to 404 and logs error', async () => {
    const err = new Error('access denied');
    err.name = 'AccessDenied';
    err.$metadata = { httpStatusCode: 403 };
    mockS3.s3Client.send.rejects(err);

    const response = await controller.getRedirects(requestContext);
    expect(response.status).to.equal(404);
    // Logged at error so a missing IAM grant (every request 403) stays alertable.
    expect(mockContext.log.error.called).to.be.true;
  });

  it('returns 500 on an unexpected S3 error', async () => {
    mockS3.s3Client.send.rejects(new Error('boom'));
    const response = await controller.getRedirects(requestContext);
    expect(response.status).to.equal(500);
    expect(mockContext.log.error.called).to.be.true;
  });

  it('returns 500 when the overlays bucket is not configured', async () => {
    const ctl = RedirectsController({ ...mockContext, env: {} });
    const response = await ctl.getRedirects(requestContext);
    expect(response.status).to.equal(500);
    expect(mockS3.s3Client.send.called).to.be.false;
  });
});
