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

/**
 * Metric-focused tests for RedirectsController. Complements redirects.test.js
 * (which asserts response shape); here we assert the CloudWatch EMF stdout
 * envelopes that on-call dashboards depend on. Uses sandbox.stub on
 * console.log — matches how metrics-emf.js writes to stdout by default.
 */

import { expect } from 'chai';
import sinon from 'sinon';

import RedirectsController from '../../src/controllers/redirects.js';
import {
  ASO_OVERLAY_NAMESPACE,
  ASO_OVERLAY_METRICS,
  OUTCOME,
  S3_RESULT,
  INM_INVALID_REASON,
} from '../../src/support/aso-overlay-metrics.js';

const BUCKET = 'spacecat-dev-aso-overlays';
const SERVICE = 'cm-p154709-e1629980';
const ORG_ID = 'org-1';
const ENTITLEMENT_ID = 'ent-aso-1';
const ETAG = '"d41d8cd98f00b204e9800998ecf8427e"';

/**
 * Parses the JSON envelopes emitted to stdout during a request and returns
 * the ones matching this endpoint's namespace. Keeps tests concise — every
 * assertion below asks "was metric X emitted with these dimensions?"
 */
/* eslint-disable no-underscore-dangle */
function parseEmf(arg) {
  if (typeof arg !== 'string') {
    return null;
  }
  try {
    return JSON.parse(arg);
  } catch {
    return null;
  }
}

function metricsFrom(logStub) {
  const nsMatches = (env) => env
    ?._aws?.CloudWatchMetrics?.[0]?.Namespace === ASO_OVERLAY_NAMESPACE;
  return logStub.getCalls()
    .map((call) => parseEmf(call.args[0]))
    .filter(nsMatches)
    .map((env) => {
      const metric = env._aws.CloudWatchMetrics[0].Metrics[0];
      return {
        name: metric.Name,
        unit: metric.Unit,
        value: env[metric.Name],
        environment: env.Environment,
        outcome: env.Outcome,
        s3result: env.S3Result,
        reason: env.Reason,
        slot: env.Slot,
      };
    });
}
/* eslint-enable no-underscore-dangle */

function findMetric(envelopes, name, extraFilter = {}) {
  return envelopes.find(
    (e) => e.name === name && Object.entries(extraFilter).every(([k, v]) => e[k] === v),
  );
}

describe('RedirectsController — CloudWatch EMF metrics', () => {
  let sandbox;
  let logStub;
  let mockS3;
  let mockDataAccess;
  let mockContext;
  let controller;
  let requestContext;

  const withIfNoneMatch = (value) => {
    requestContext.pathInfo.headers['if-none-match'] = value;
  };

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    logStub = sandbox.stub(console, 'log');

    mockS3 = {
      s3Client: { send: sandbox.stub() },
      GetObjectCommand: sandbox.stub().callsFake((params) => ({ input: params })),
    };
    mockDataAccess = {
      Site: {
        findByExternalOwnerIdAndExternalSiteId: sandbox.stub().resolves(
          { getId: () => 'site-1', getOrganizationId: () => ORG_ID },
        ),
      },
      Entitlement: {
        findByOrganizationIdAndProductCode: sandbox.stub()
          .resolves({ getId: () => ENTITLEMENT_ID }),
      },
      SiteEnrollment: {
        allBySiteId: sandbox.stub().resolves([{ getEntitlementId: () => ENTITLEMENT_ID }]),
      },
    };
    mockContext = {
      s3: mockS3,
      dataAccess: mockDataAccess,
      log: { info: sandbox.stub(), error: sandbox.stub() },
      env: { S3_ASO_OVERLAYS_BUCKET: BUCKET, AWS_ENV: 'dev' },
    };
    controller = RedirectsController(mockContext);
    requestContext = {
      params: { service: SERVICE },
      pathInfo: { headers: {}, suffix: `config/dev/${SERVICE}/redirects.txt` },
    };
  });

  afterEach(() => sandbox.restore());

  it('200 path — emits RequestTotal + RequestDurationMs + EtagPresent + S3ReadDurationMs', async () => {
    mockS3.s3Client.send.resolves({
      ETag: ETAG,
      Body: { transformToString: sandbox.stub().resolves('a b\n') },
    });

    const response = await controller.getRedirects(requestContext);
    expect(response.status).to.equal(200);

    const em = metricsFrom(logStub);
    const req = findMetric(em, 'AsoOverlayRequestTotal', { outcome: OUTCOME.OK_200 });
    expect(req).to.exist;
    expect(req.value).to.equal(1);
    expect(req.environment).to.equal('dev');
    expect(findMetric(em, 'AsoOverlayRequestDurationMs', { outcome: OUTCOME.OK_200 })).to.exist;
    expect(findMetric(em, 'AsoOverlayEtagPresent')).to.exist;
    expect(findMetric(em, 'AsoOverlayS3ReadDurationMs', { s3result: S3_RESULT.SUCCESS })).to.exist;
  });

  it('200 without S3 ETag — emits RequestTotal but not EtagPresent', async () => {
    mockS3.s3Client.send.resolves({
      Body: { transformToString: sandbox.stub().resolves('a b\n') },
    });

    await controller.getRedirects(requestContext);

    const em = metricsFrom(logStub);
    expect(findMetric(em, 'AsoOverlayRequestTotal', { outcome: OUTCOME.OK_200 })).to.exist;
    expect(findMetric(em, 'AsoOverlayEtagPresent')).to.not.exist;
  });

  it('304 path — emits ConditionalGet304 + RequestTotal(304)', async () => {
    mockS3.s3Client.send.resolves({
      ETag: ETAG,
      Body: { transformToString: sandbox.stub().resolves('a b\n') },
    });
    withIfNoneMatch(ETAG);

    const response = await controller.getRedirects(requestContext);
    expect(response.status).to.equal(304);

    const em = metricsFrom(logStub);
    expect(findMetric(em, 'AsoOverlayConditionalGet304')).to.exist;
    expect(findMetric(em, 'AsoOverlayRequestTotal', { outcome: OUTCOME.NOT_MODIFIED_304 })).to.exist;
    // Etag is not counted separately on 304 (only on 200) — the 304 branch itself
    // is the "we honored the client's validator" signal.
    expect(findMetric(em, 'AsoOverlayEtagPresent')).to.not.exist;
  });

  it('unquoted If-None-Match — emits IfNoneMatchInvalid{Reason=unquoted}', async () => {
    mockS3.s3Client.send.resolves({
      ETag: ETAG,
      Body: { transformToString: sandbox.stub().resolves('a b\n') },
    });
    // Bare hex without quotes — rejected by normalizeValidator, falls to 200.
    withIfNoneMatch('d41d8cd98f00b204e9800998ecf8427e');

    const response = await controller.getRedirects(requestContext);
    expect(response.status).to.equal(200);

    const em = metricsFrom(logStub);
    expect(findMetric(em, 'AsoOverlayIfNoneMatchInvalid', { reason: INM_INVALID_REASON.UNQUOTED })).to.exist;
  });

  it('whitespace-only If-None-Match — treated as absent (no IfNoneMatchInvalid metric)', async () => {
    // getHeader() in src/support/http-headers.js normalizes whitespace-only
    // headers to null, so the controller sees "no INM" and serves a plain 200.
    mockS3.s3Client.send.resolves({
      ETag: ETAG,
      Body: { transformToString: sandbox.stub().resolves('a b\n') },
    });
    withIfNoneMatch('   ');

    await controller.getRedirects(requestContext);

    const em = metricsFrom(logStub);
    expect(findMetric(em, 'AsoOverlayIfNoneMatchInvalid')).to.not.exist;
    expect(findMetric(em, 'AsoOverlayRequestTotal', { outcome: OUTCOME.OK_200 })).to.exist;
  });

  it('well-formed but stale If-None-Match — no IfNoneMatchInvalid (this is a normal cache miss)', async () => {
    mockS3.s3Client.send.resolves({
      ETag: ETAG,
      Body: { transformToString: sandbox.stub().resolves('a b\n') },
    });
    withIfNoneMatch('"stale-tag"');

    await controller.getRedirects(requestContext);

    const em = metricsFrom(logStub);
    expect(findMetric(em, 'AsoOverlayIfNoneMatchInvalid')).to.not.exist;
    expect(findMetric(em, 'AsoOverlayRequestTotal', { outcome: OUTCOME.OK_200 })).to.exist;
  });

  it('400 malformed service — emits RequestTotal(400)', async () => {
    requestContext.params.service = 'not-a-cm-service';
    const response = await controller.getRedirects(requestContext);
    expect(response.status).to.equal(400);

    const em = metricsFrom(logStub);
    expect(findMetric(em, 'AsoOverlayRequestTotal', { outcome: OUTCOME.BAD_REQUEST_400 })).to.exist;
    // Never reached S3 → no S3 read metric.
    expect(findMetric(em, 'AsoOverlayS3ReadDurationMs')).to.not.exist;
  });

  it('500 bucket not configured — emits RequestTotal(500-config)', async () => {
    const ctl = RedirectsController({ ...mockContext, env: { AWS_ENV: 'dev' } });
    const response = await ctl.getRedirects(requestContext);
    expect(response.status).to.equal(500);

    const em = metricsFrom(logStub);
    expect(findMetric(em, 'AsoOverlayRequestTotal', { outcome: OUTCOME.BUCKET_NOT_CONFIGURED })).to.exist;
  });

  it('404 authz — site not found — emits RequestTotal(404-authz-nosite), no S3 metric', async () => {
    mockDataAccess.Site.findByExternalOwnerIdAndExternalSiteId.resolves(null);
    const response = await controller.getRedirects(requestContext);
    expect(response.status).to.equal(404);

    const em = metricsFrom(logStub);
    expect(findMetric(em, 'AsoOverlayRequestTotal', { outcome: OUTCOME.AUTHZ_NO_SITE })).to.exist;
    expect(findMetric(em, 'AsoOverlayS3ReadDurationMs')).to.not.exist;
  });

  it('404 authz — no entitlement — emits RequestTotal(404-authz-noent)', async () => {
    mockDataAccess.Entitlement.findByOrganizationIdAndProductCode.resolves(null);
    const response = await controller.getRedirects(requestContext);
    expect(response.status).to.equal(404);

    const em = metricsFrom(logStub);
    expect(findMetric(em, 'AsoOverlayRequestTotal', { outcome: OUTCOME.AUTHZ_NO_ENTITLEMENT })).to.exist;
  });

  it('404 authz — not enrolled — emits RequestTotal(404-authz-noenroll)', async () => {
    mockDataAccess.SiteEnrollment.allBySiteId.resolves([{ getEntitlementId: () => 'other' }]);
    const response = await controller.getRedirects(requestContext);
    expect(response.status).to.equal(404);

    const em = metricsFrom(logStub);
    expect(findMetric(em, 'AsoOverlayRequestTotal', { outcome: OUTCOME.AUTHZ_NOT_ENROLLED })).to.exist;
  });

  it('404 S3 NoSuchKey — emits RequestTotal(404-s3-nosuchkey) and S3ReadDurationMs{nosuchkey}', async () => {
    const err = new Error('nope');
    err.name = 'NoSuchKey';
    mockS3.s3Client.send.rejects(err);

    const response = await controller.getRedirects(requestContext);
    expect(response.status).to.equal(404);

    const em = metricsFrom(logStub);
    expect(findMetric(em, 'AsoOverlayRequestTotal', { outcome: OUTCOME.S3_NO_SUCH_KEY })).to.exist;
    expect(findMetric(em, 'AsoOverlayS3ReadDurationMs', { s3result: S3_RESULT.NO_SUCH_KEY })).to.exist;
  });

  it('404 S3 AccessDenied — emits RequestTotal(404-s3-accessdenied) and S3ReadDurationMs{accessdenied}', async () => {
    const err = new Error('denied');
    err.name = 'AccessDenied';
    err.$metadata = { httpStatusCode: 403 };
    mockS3.s3Client.send.rejects(err);

    const response = await controller.getRedirects(requestContext);
    expect(response.status).to.equal(404);

    const em = metricsFrom(logStub);
    expect(findMetric(em, 'AsoOverlayRequestTotal', { outcome: OUTCOME.S3_ACCESS_DENIED })).to.exist;
    expect(findMetric(em, 'AsoOverlayS3ReadDurationMs', { s3result: S3_RESULT.ACCESS_DENIED })).to.exist;
  });

  it('500 unexpected S3 error — emits RequestTotal(500-s3) and S3ReadDurationMs{unexpected}', async () => {
    mockS3.s3Client.send.rejects(new Error('boom'));
    const response = await controller.getRedirects(requestContext);
    expect(response.status).to.equal(500);

    const em = metricsFrom(logStub);
    expect(findMetric(em, 'AsoOverlayRequestTotal', { outcome: OUTCOME.S3_UNEXPECTED })).to.exist;
    expect(findMetric(em, 'AsoOverlayS3ReadDurationMs', { s3result: S3_RESULT.UNEXPECTED })).to.exist;
  });

  it('200 happy path — emits S3ReadDurationMs{success}', async () => {
    mockS3.s3Client.send.resolves({
      ETag: ETAG,
      Body: { transformToString: sandbox.stub().resolves('a b\n') },
    });

    await controller.getRedirects(requestContext);

    const em = metricsFrom(logStub);
    expect(findMetric(em, 'AsoOverlayS3ReadDurationMs', { s3result: S3_RESULT.SUCCESS })).to.exist;
  });

  it('drift guard — every metric emitted by getRedirects appears in ASO_OVERLAY_METRICS', async () => {
    // Exercise a mix of terminal branches so the emitter fires most metrics.
    const scenarios = [
      // 200 with ETag + INM matching = 304
      async () => {
        mockS3.s3Client.send.resolves({
          ETag: ETAG, Body: { transformToString: sandbox.stub().resolves('x\n') },
        });
        withIfNoneMatch(ETAG);
        await controller.getRedirects(requestContext);
      },
      // 200 with unquoted INM
      async () => {
        mockS3.s3Client.send.resolves({
          ETag: ETAG, Body: { transformToString: sandbox.stub().resolves('x\n') },
        });
        withIfNoneMatch('bare-token');
        await controller.getRedirects(requestContext);
      },
      // 500 unexpected S3
      async () => {
        mockS3.s3Client.send.rejects(new Error('boom'));
        await controller.getRedirects(requestContext);
      },
    ];
    // Sequential execution is intentional: each scenario re-stubs the sandbox
    // so parallel awaits would race. The catalog check runs against the union.
    await scenarios.reduce(async (acc, run) => {
      await acc;
      sandbox.restore();
      sandbox = sinon.createSandbox();
      logStub = sandbox.stub(console, 'log');
      mockS3.s3Client.send = sandbox.stub();
      await run();
    }, Promise.resolve());
    const emitted = new Set(metricsFrom(logStub).map((e) => e.name));
    for (const name of emitted) {
      expect(ASO_OVERLAY_METRICS).to.include(
        name,
        `Emitted metric "${name}" is not in the ASO_OVERLAY_METRICS drift-guard catalog. `
        + 'Either add it to src/support/aso-overlay-metrics.js or fix the emit site.',
      );
    }
  });
});
