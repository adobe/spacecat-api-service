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

import AsoOverlayKeyHandler from '../../src/support/aso-overlay-key-handler.js';
import {
  ASO_OVERLAY_NAMESPACE,
  AUTH_FAIL_REASON,
  AUTH_KEY_SLOT,
} from '../../src/support/aso-overlay-metrics.js';

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
    .map((env) => ({
      name: env._aws.CloudWatchMetrics[0].Metrics[0].Name,
      slot: env.Slot,
      reason: env.Reason,
      environment: env.Environment,
    }));
}
/* eslint-enable no-underscore-dangle */

const findMetric = (em, name, extra = {}) => em.find(
  (e) => e.name === name && Object.entries(extra).every(([k, v]) => e[k] === v),
);

const OVERLAY_SUFFIX = 'config/cm-p154709-e1629980/redirects.txt';

describe('AsoOverlayKeyHandler — metrics', () => {
  let sandbox;
  let logStub;
  let handler;
  let context;
  let request;

  const requestWith = (headers = {}) => ({
    headers: { get: (h) => headers[h.toLowerCase()] ?? null },
  });

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    logStub = sandbox.stub(console, 'log');
    // AbstractHandler.log(msg, level) calls this.logger[level](msg) — needs a real
    // logger shape, not a bare stub.
    const logger = {
      info: sandbox.stub(), warn: sandbox.stub(), error: sandbox.stub(), debug: sandbox.stub(),
    };
    handler = new AsoOverlayKeyHandler(logger);
    context = {
      pathInfo: { method: 'GET', suffix: OVERLAY_SUFFIX },
      env: { ASO_OVERLAY_API_KEY: 'current-key', AWS_ENV: 'dev' },
    };
    request = requestWith({ 'x-aso-api-key': 'current-key' });
  });

  afterEach(() => sandbox.restore());

  it('current-key match — emits AuthKeyUsed{Slot=current}', async () => {
    const result = await handler.checkAuth(request, context);
    expect(result).to.not.equal(null);
    const em = metricsFrom(logStub);
    expect(findMetric(em, 'AsoOverlayAuthKeyUsed', { slot: AUTH_KEY_SLOT.CURRENT })).to.exist;
    expect(findMetric(em, 'AsoOverlayAuthFailed')).to.not.exist;
  });

  it('previous-key match — emits AuthKeyUsed{Slot=previous} (rotation-in-flight signal)', async () => {
    context.env.ASO_OVERLAY_API_KEY_PREVIOUS = 'old-key';
    request = requestWith({ 'x-aso-api-key': 'old-key' });

    const result = await handler.checkAuth(request, context);
    expect(result).to.not.equal(null);
    const em = metricsFrom(logStub);
    expect(findMetric(em, 'AsoOverlayAuthKeyUsed', { slot: AUTH_KEY_SLOT.PREVIOUS })).to.exist;
  });

  it('missing header on overlay route — emits AuthFailed{Reason=missing}', async () => {
    request = requestWith({});
    const result = await handler.checkAuth(request, context);
    expect(result).to.equal(null);
    const em = metricsFrom(logStub);
    expect(findMetric(em, 'AsoOverlayAuthFailed', { reason: AUTH_FAIL_REASON.MISSING })).to.exist;
    expect(findMetric(em, 'AsoOverlayAuthKeyUsed')).to.not.exist;
  });

  it('invalid key on overlay route — emits AuthFailed{Reason=invalid}', async () => {
    request = requestWith({ 'x-aso-api-key': 'wrong-key' });
    const result = await handler.checkAuth(request, context);
    expect(result).to.equal(null);
    const em = metricsFrom(logStub);
    expect(findMetric(em, 'AsoOverlayAuthFailed', { reason: AUTH_FAIL_REASON.INVALID })).to.exist;
  });

  it('ASO_OVERLAY_API_KEY unset — emits AuthFailed{Reason=config-missing}', async () => {
    context.env.ASO_OVERLAY_API_KEY = '';
    const result = await handler.checkAuth(request, context);
    expect(result).to.equal(null);
    const em = metricsFrom(logStub);
    expect(findMetric(em, 'AsoOverlayAuthFailed', { reason: AUTH_FAIL_REASON.CONFIG_MISSING })).to.exist;
  });

  it('non-overlay route — NO metric emitted (path scope guard)', async () => {
    context.pathInfo.suffix = 'some/other/path';
    const result = await handler.checkAuth(request, context);
    expect(result).to.equal(null);
    const em = metricsFrom(logStub);
    // Nothing at all — this handler runs on every request and would flood the namespace.
    expect(em).to.have.length(0);
  });

  it('non-GET method on overlay route — NO metric emitted', async () => {
    context.pathInfo.method = 'POST';
    const result = await handler.checkAuth(request, context);
    expect(result).to.equal(null);
    const em = metricsFrom(logStub);
    expect(em).to.have.length(0);
  });
});
