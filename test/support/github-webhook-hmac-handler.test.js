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

import { expect } from 'chai';
import sinon from 'sinon';
import crypto from 'crypto';
import GitHubWebhookHmacHandler from '../../src/support/github-webhook-hmac-handler.js';

describe('GitHubWebhookHmacHandler', () => {
  let handler;
  let sandbox;
  let mockLog;
  const secret = 'test-webhook-secret';
  const validPayload = JSON.stringify({ action: 'review_requested', installation: { id: 123 } });

  function computeSignature(body, key = secret) {
    return `sha256=${crypto.createHmac('sha256', key).update(body).digest('hex')}`;
  }

  function makeRequest(headers = {}, body = validPayload) {
    return {
      headers: { get: (name) => headers[name] || null },
      text: sinon.stub().resolves(body),
    };
  }

  function makeContext(overrides = {}) {
    return {
      pathInfo: { suffix: '/webhooks/github' },
      env: { GITHUB_WEBHOOK_SECRET: secret },
      ...overrides,
    };
  }

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    mockLog = {
      info: sandbox.stub(),
      warn: sandbox.stub(),
      error: sandbox.stub(),
    };
    handler = new GitHubWebhookHmacHandler(mockLog);
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('returns AuthInfo with type github_webhook on valid signature', async () => {
    const sig = computeSignature(validPayload);
    const request = makeRequest({ 'x-hub-signature-256': sig });
    const context = makeContext();

    const result = await handler.checkAuth(request, context);

    expect(result).to.not.be.null;
    expect(result.type).to.equal('github_webhook');
    expect(result.authenticated).to.be.true;
  });

  it('accepts webhook path without leading slash', async () => {
    const sig = computeSignature(validPayload);
    const request = makeRequest({ 'x-hub-signature-256': sig });
    const context = makeContext({ pathInfo: { suffix: 'webhooks/github' } });

    const result = await handler.checkAuth(request, context);

    expect(result).to.not.be.null;
    expect(result.type).to.equal('github_webhook');
  });

  it('accepts webhook path with leading slash', async () => {
    const sig = computeSignature(validPayload);
    const request = makeRequest({ 'x-hub-signature-256': sig });
    const context = makeContext({ pathInfo: { suffix: '/webhooks/github' } });

    const result = await handler.checkAuth(request, context);

    expect(result).to.not.be.null;
    expect(result.type).to.equal('github_webhook');
  });

  it('returns null for non-webhook path', async () => {
    const sig = computeSignature(validPayload);
    const request = makeRequest({ 'x-hub-signature-256': sig });
    const context = makeContext({ pathInfo: { suffix: '/sites/123' } });

    const result = await handler.checkAuth(request, context);

    expect(result).to.be.null;
    expect(request.text.called).to.be.false;
  });

  it('returns null when signature header is missing', async () => {
    const request = makeRequest({});
    const context = makeContext();

    const result = await handler.checkAuth(request, context);

    expect(result).to.be.null;
  });

  it('returns null and logs error when GITHUB_WEBHOOK_SECRET is not configured', async () => {
    const sig = computeSignature(validPayload);
    const request = makeRequest({ 'x-hub-signature-256': sig });
    const context = makeContext({ env: {} });

    const result = await handler.checkAuth(request, context);

    expect(result).to.be.null;
    expect(mockLog.error.calledOnce).to.be.true;
    expect(mockLog.error.firstCall.args[0]).to.include('misconfigured=true');
  });

  it('returns null and logs warn for malformed signature (missing sha256= prefix)', async () => {
    const request = makeRequest({ 'x-hub-signature-256': 'abc123' });
    const context = makeContext();

    const result = await handler.checkAuth(request, context);

    expect(result).to.be.null;
    expect(mockLog.warn.calledOnce).to.be.true;
    expect(mockLog.warn.firstCall.args[0]).to.include('Malformed');
  });

  it('returns null and logs warn for signature with wrong byte length', async () => {
    const request = makeRequest({ 'x-hub-signature-256': 'sha256=tooshort' });
    const context = makeContext();

    const result = await handler.checkAuth(request, context);

    expect(result).to.be.null;
    expect(mockLog.warn.calledOnce).to.be.true;
  });

  it('returns null and logs warn for empty request body', async () => {
    const sig = computeSignature(validPayload);
    const request = makeRequest({ 'x-hub-signature-256': sig }, '');
    const context = makeContext();

    const result = await handler.checkAuth(request, context);

    expect(result).to.be.null;
    expect(mockLog.warn.calledOnce).to.be.true;
    expect(mockLog.warn.firstCall.args[0]).to.include('Empty');
  });

  it('returns null and logs warn for invalid signature (wrong secret)', async () => {
    const wrongSig = computeSignature(validPayload, 'wrong-secret');
    const request = makeRequest({ 'x-hub-signature-256': wrongSig });
    const context = makeContext();

    const result = await handler.checkAuth(request, context);

    expect(result).to.be.null;
    expect(mockLog.warn.calledOnce).to.be.true;
    expect(mockLog.warn.firstCall.args[0]).to.include('mismatch');
  });

  it('returns null and logs warn when content-length exceeds limit', async () => {
    const sig = computeSignature(validPayload);
    // 2 MiB, above our 1 MiB limit
    const request = makeRequest({ 'x-hub-signature-256': sig, 'content-length': '2097152' });
    const context = makeContext();

    const result = await handler.checkAuth(request, context);

    expect(result).to.be.null;
    expect(mockLog.warn.calledOnce).to.be.true;
    expect(mockLog.warn.firstCall.args[0]).to.include('Payload too large');
    expect(request.text.called).to.be.false;
  });

  it('returns null and logs warn when actual body size exceeds limit', async () => {
    const oversized = 'x'.repeat(1024 * 1024 + 1);
    const sig = computeSignature(oversized);
    // No content-length header so we only catch this after reading
    const request = makeRequest({ 'x-hub-signature-256': sig }, oversized);
    const context = makeContext();

    const result = await handler.checkAuth(request, context);

    expect(result).to.be.null;
    expect(mockLog.warn.calledOnce).to.be.true;
    expect(mockLog.warn.firstCall.args[0]).to.include('Payload too large after read');
  });

  it('rejects signature computed over JSON.stringify (proves raw body matters)', async () => {
    // Raw body has specific whitespace; JSON.stringify would produce different bytes
    const rawBody = '{"action":  "review_requested"}';
    const reserialized = JSON.stringify(JSON.parse(rawBody));
    expect(rawBody).to.not.equal(reserialized);

    const sigFromRaw = computeSignature(rawBody);
    const sigFromReserialized = computeSignature(reserialized);
    expect(sigFromRaw).to.not.equal(sigFromReserialized);

    // Handler should validate against raw body, not reserialized
    const request = makeRequest({ 'x-hub-signature-256': sigFromRaw }, rawBody);
    const context = makeContext();

    const result = await handler.checkAuth(request, context);
    expect(result).to.not.be.null;
  });
});
