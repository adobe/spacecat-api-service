import { expect } from 'chai';
import sinon from 'sinon';
import crypto from 'crypto';
import GitHubWebhookHmacHandler from '../../src/support/github-webhook-hmac-handler.js';

describe('GitHubWebhookHmacHandler', () => {
  let handler;
  let sandbox;
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
      pathInfo: { suffix: 'webhooks/github' },
      env: { GITHUB_WEBHOOK_SECRET: secret },
      ...overrides,
    };
  }

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    const log = {
      info: sandbox.stub(),
      warn: sandbox.stub(),
      error: sandbox.stub(),
    };
    handler = new GitHubWebhookHmacHandler(log);
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

  it('stashes rawBody on context on success', async () => {
    const sig = computeSignature(validPayload);
    const request = makeRequest({ 'x-hub-signature-256': sig });
    const context = makeContext();

    await handler.checkAuth(request, context);

    expect(context.rawBody).to.equal(validPayload);
  });

  it('returns null for non-webhook path', async () => {
    const sig = computeSignature(validPayload);
    const request = makeRequest({ 'x-hub-signature-256': sig });
    const context = makeContext({ pathInfo: { suffix: 'sites/123' } });

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

  it('returns null when GITHUB_WEBHOOK_SECRET is not configured', async () => {
    const sig = computeSignature(validPayload);
    const request = makeRequest({ 'x-hub-signature-256': sig });
    const context = makeContext({ env: {} });

    const result = await handler.checkAuth(request, context);

    expect(result).to.be.null;
  });

  it('returns null for malformed signature (missing sha256= prefix)', async () => {
    const request = makeRequest({ 'x-hub-signature-256': 'abc123' });
    const context = makeContext();

    const result = await handler.checkAuth(request, context);

    expect(result).to.be.null;
  });

  it('returns null for signature with wrong byte length', async () => {
    const request = makeRequest({ 'x-hub-signature-256': 'sha256=tooshort' });
    const context = makeContext();

    const result = await handler.checkAuth(request, context);

    expect(result).to.be.null;
  });

  it('returns null for empty request body', async () => {
    const sig = computeSignature(validPayload);
    const request = makeRequest({ 'x-hub-signature-256': sig }, '');
    const context = makeContext();

    const result = await handler.checkAuth(request, context);

    expect(result).to.be.null;
  });

  it('returns null for invalid signature (wrong secret)', async () => {
    const wrongSig = computeSignature(validPayload, 'wrong-secret');
    const request = makeRequest({ 'x-hub-signature-256': wrongSig });
    const context = makeContext();

    const result = await handler.checkAuth(request, context);

    expect(result).to.be.null;
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
