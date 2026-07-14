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

  // Helper: set an `If-None-Match` header on the current request context.
  // Tests mutate this map rather than replacing `pathInfo` wholesale so that
  // if the controller starts reading other pathInfo fields, tests don't
  // silently drop them.
  const withIfNoneMatch = (value) => {
    requestContext.pathInfo.headers['if-none-match'] = value;
  };

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
    requestContext = { params: { service: SERVICE }, pathInfo: { headers: {} } };
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
    // Defensive: S3 always returns ETag for a successful GET, but a mock or
    // future storage backend might not — the conditional-GET path degrades to
    // a plain 200 rather than breaking.
    const overlay = 'example.com/old https://www.example.com/new\n';
    mockS3.s3Client.send.resolves({
      Body: { transformToString: sandbox.stub().resolves(overlay) },
    });

    const response = await controller.getRedirects(requestContext);

    expect(response.status).to.equal(200);
    expect(response.headers.get('etag')).to.be.null;
    expect(await response.text()).to.equal(overlay);
  });

  it('serves 200 when the request context has no pathInfo (defensive)', async () => {
    // getHeader tolerates a missing pathInfo — controller must not throw.
    delete requestContext.pathInfo;
    const overlay = 'x y\n';
    mockS3.s3Client.send.resolves({
      ETag: ETAG,
      Body: { transformToString: sandbox.stub().resolves(overlay) },
    });

    const response = await controller.getRedirects(requestContext);
    expect(response.status).to.equal(200);
    expect(await response.text()).to.equal(overlay);
  });

  it('returns 304 with ETag + Cache-Control and no body when If-None-Match matches', async () => {
    const overlay = 'example.com/old https://www.example.com/new\n';
    const bodyStub = sandbox.stub().resolves(overlay);
    mockS3.s3Client.send.resolves({
      ETag: ETAG,
      Body: { transformToString: bodyStub },
    });
    withIfNoneMatch(ETAG);

    const response = await controller.getRedirects(requestContext);

    expect(response.status).to.equal(304);
    expect(response.headers.get('etag')).to.equal(ETAG);
    expect(response.headers.get('cache-control')).to.equal('max-age=10');
    expect(response.headers.get('content-type')).to.equal('text/plain; charset=utf-8');
    expect(await response.text()).to.equal('');
    // Body never deserialized when returning 304 — the transformToString cost is elided.
    expect(bodyStub.called).to.be.false;
  });

  it('accepts a mixed-case if-none-match header (HTTP header names are case-insensitive)', async () => {
    mockS3.s3Client.send.resolves({
      ETag: ETAG,
      Body: { transformToString: sandbox.stub().resolves('') },
    });
    requestContext.pathInfo.headers['If-None-Match'] = ETAG;

    const response = await controller.getRedirects(requestContext);
    expect(response.status).to.equal(304);
  });

  it('returns 304 when If-None-Match: * and the resource exists', async () => {
    mockS3.s3Client.send.resolves({
      ETag: ETAG,
      Body: { transformToString: sandbox.stub().resolves('') },
    });
    withIfNoneMatch('*');

    const response = await controller.getRedirects(requestContext);
    expect(response.status).to.equal(304);
  });

  it('returns 304 on If-None-Match: * even when S3 omits ETag (RFC 7232 §3.2)', async () => {
    // `*` matches any existing representation. The controller only reaches
    // the conditional-GET branch after a successful S3 GET, so a rep exists.
    mockS3.s3Client.send.resolves({
      Body: { transformToString: sandbox.stub().resolves('') },
    });
    withIfNoneMatch('*');

    const response = await controller.getRedirects(requestContext);
    expect(response.status).to.equal(304);
    // No ETag was available to echo back, but 304 is still correct for `*`.
    expect(response.headers.get('etag')).to.be.null;
  });

  it('returns 304 when If-None-Match is a multi-value list containing the current ETag', async () => {
    mockS3.s3Client.send.resolves({
      ETag: ETAG,
      Body: { transformToString: sandbox.stub().resolves('') },
    });
    withIfNoneMatch(`"other", ${ETAG}, "another"`);

    const response = await controller.getRedirects(requestContext);
    expect(response.status).to.equal(304);
  });

  it('returns 304 for a mixed weak/strong list where a weak-tagged validator matches', async () => {
    mockS3.s3Client.send.resolves({
      ETag: ETAG,
      Body: { transformToString: sandbox.stub().resolves('') },
    });
    withIfNoneMatch(`"other", W/${ETAG}, "another"`);

    const response = await controller.getRedirects(requestContext);
    expect(response.status).to.equal(304);
  });

  it('treats W/"tag" and "tag" as equivalent under RFC 7232 weak comparison', async () => {
    mockS3.s3Client.send.resolves({
      ETag: ETAG,
      Body: { transformToString: sandbox.stub().resolves('') },
    });
    withIfNoneMatch(`W/${ETAG}`);

    const response = await controller.getRedirects(requestContext);
    expect(response.status).to.equal(304);
  });

  it('serves 200 when S3 returns a malformed (unquoted) ETag even if the client-sent validator would textually match', async () => {
    // Defense in depth: if S3 (or a future backend) surfaces a validator that
    // is not a proper quoted opaque-tag, we must not honor conditional GETs
    // against it — serve the body so the client can rebuild derived state.
    const overlay = 'x y\n';
    mockS3.s3Client.send.resolves({
      ETag: 'malformed-no-quotes',
      Body: { transformToString: sandbox.stub().resolves(overlay) },
    });
    withIfNoneMatch('"malformed-no-quotes"');

    const response = await controller.getRedirects(requestContext);
    expect(response.status).to.equal(200);
    // The malformed ETag is still passed through on the 200 (defensive — it's
    // opaque to us; that's between the writer and the client's cache).
    expect(await response.text()).to.equal(overlay);
  });

  it('serves 200 when S3 omits ETag and client sends a specific (non-*) validator', async () => {
    // Belt-and-braces: with no server ETag and a specific INM, the compare
    // must yield "no match" — never a spurious 304 against undefined.
    // Also exercises the `currentEtag || ''` fallback in ifNoneMatchMatches.
    const overlay = 'x y\n';
    mockS3.s3Client.send.resolves({
      Body: { transformToString: sandbox.stub().resolves(overlay) },
    });
    withIfNoneMatch(ETAG);

    const response = await controller.getRedirects(requestContext);
    expect(response.status).to.equal(200);
    expect(await response.text()).to.equal(overlay);
    expect(response.headers.get('etag')).to.be.null;
  });

  it('rejects an unquoted validator (must be an RFC 7232 opaque-tag) and serves 200', async () => {
    // `abc` without surrounding quotes is not a valid opaque-tag. Accepting
    // it would silently 304 against a shell-stripped or otherwise corrupted
    // validator instead of forcing a fresh fetch.
    const overlay = 'x y\n';
    mockS3.s3Client.send.resolves({
      ETag: ETAG,
      Body: { transformToString: sandbox.stub().resolves(overlay) },
    });
    withIfNoneMatch('d41d8cd98f00b204e9800998ecf8427e'); // no quotes

    const response = await controller.getRedirects(requestContext);
    expect(response.status).to.equal(200);
    expect(await response.text()).to.equal(overlay);
  });

  it('rejects a lowercase weak prefix (RFC 7232 §2.3 W/ is case-sensitive) and serves 200', async () => {
    // `w/"..."` is malformed. We deliberately do not normalize to lowercase.
    const overlay = 'x y\n';
    mockS3.s3Client.send.resolves({
      ETag: ETAG,
      Body: { transformToString: sandbox.stub().resolves(overlay) },
    });
    withIfNoneMatch(`w/${ETAG}`);

    const response = await controller.getRedirects(requestContext);
    expect(response.status).to.equal(200);
    expect(await response.text()).to.equal(overlay);
  });

  it('returns 200 with fresh body when If-None-Match does not match the current ETag', async () => {
    const overlay = 'example.com/new https://www.example.com/x\n';
    mockS3.s3Client.send.resolves({
      ETag: ETAG,
      Body: { transformToString: sandbox.stub().resolves(overlay) },
    });
    withIfNoneMatch('"stale-etag"');

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
    withIfNoneMatch('   ');

    const response = await controller.getRedirects(requestContext);
    expect(response.status).to.equal(200);
    expect(await response.text()).to.equal(overlay);
  });

  it('does not reflect CRLF / control chars from If-None-Match into response headers', async () => {
    // Defense in depth: even though the header is never echoed, verify a
    // malicious client with an injected `\r\n` cannot smuggle a header via
    // If-None-Match. The value should be treated as opaque validator input.
    const overlay = 'x y\n';
    mockS3.s3Client.send.resolves({
      ETag: ETAG,
      Body: { transformToString: sandbox.stub().resolves(overlay) },
    });
    withIfNoneMatch(`${ETAG}\r\nX-Injected: evil`);

    const response = await controller.getRedirects(requestContext);
    // Injected token does not match the strong current ETag, so we serve 200.
    expect(response.status).to.equal(200);
    expect(response.headers.get('x-injected')).to.be.null;
  });

  it('still returns 404 (not 304) when the site does not resolve — no enumeration signal via If-None-Match', async () => {
    // Guard: If-None-Match must not short-circuit authz. A non-entitled tenant
    // sending a valid ETag for some *other* tenant's overlay must still 404.
    mockDataAccess.Site.findByExternalOwnerIdAndExternalSiteId.resolves(null);
    withIfNoneMatch(ETAG);

    const response = await controller.getRedirects(requestContext);
    expect(response.status).to.equal(404);
    // Authz failed before S3 was touched.
    expect(mockS3.s3Client.send.called).to.be.false;
  });

  it('still returns 404 (not 304) when If-None-Match: * is sent by a non-entitled tenant', async () => {
    mockDataAccess.Entitlement.findByOrganizationIdAndProductCode.resolves(null);
    withIfNoneMatch('*');

    const response = await controller.getRedirects(requestContext);
    expect(response.status).to.equal(404);
    expect(mockS3.s3Client.send.called).to.be.false;
  });

  it('still returns 404 (not 304) when an unenrolled site sends If-None-Match', async () => {
    // Third authz gate: site + entitlement pass, enrollment fails.
    mockDataAccess.SiteEnrollment.allBySiteId.resolves([
      { getEntitlementId: () => 'some-other-entitlement' },
    ]);
    withIfNoneMatch(ETAG);

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
