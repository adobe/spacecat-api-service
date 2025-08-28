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
import {
  normalizeAndValidateAuditTypes,
  enforceRateLimit,
  triggerAudits,
} from '../../src/support/sandbox-audit-service.js';

// Helper to create a mock Site with controllable audit history
function createMockSite(lastAuditDateIso) {
  return {
    getId: () => 'site-123',
    getBaseURL: () => 'https://sandbox.example.com',
    getLatestAuditByAuditType: sinon.stub().callsFake((_) => (lastAuditDateIso ? {
      getAuditedAt: () => lastAuditDateIso,
    } : null)),
  };
}

describe('sandbox-audit-service helpers', () => {
  describe('normalizeAndValidateAuditTypes()', () => {
    it('returns empty array when input is undefined', () => {
      const result = normalizeAndValidateAuditTypes(undefined);
      expect(result).to.deep.equal({ auditTypes: [] });
    });

    it('returns empty array when input is null', () => {
      const result = normalizeAndValidateAuditTypes(null);
      expect(result).to.deep.equal({ auditTypes: [] });
    });

    it('normalizes array input', () => {
      const result = normalizeAndValidateAuditTypes(['meta-tags', 'alt-text']);
      expect(result).to.deep.equal({ auditTypes: ['meta-tags', 'alt-text'] });
    });

    it('normalizes comma-separated string input', () => {
      const result = normalizeAndValidateAuditTypes('meta-tags,alt-text');
      expect(result).to.deep.equal({ auditTypes: ['meta-tags', 'alt-text'] });
    });

    it('returns error for invalid audit types', async () => {
      const result = normalizeAndValidateAuditTypes(['invalid-audit', 'cwv']);
      expect(result).to.have.property('error');
      expect(result.error.status).to.equal(400);
      const body = await result.error.json();
      expect(body).to.have.property('message', 'Invalid audit types: invalid-audit, cwv. Supported types: meta-tags, alt-text');
    });

    it('returns error for mixed valid and invalid audit types', async () => {
      const result = normalizeAndValidateAuditTypes(['meta-tags', 'invalid-audit']);
      expect(result).to.have.property('error');
      expect(result.error.status).to.equal(400);
      const body = await result.error.json();
      expect(body).to.have.property('message', 'Invalid audit types: invalid-audit. Supported types: meta-tags, alt-text');
    });

    it('trims whitespace from comma-separated input', () => {
      const result = normalizeAndValidateAuditTypes(' meta-tags , alt-text ');
      expect(result).to.deep.equal({ auditTypes: ['meta-tags', 'alt-text'] });
    });

    it('filters out empty strings from comma-separated input', () => {
      const result = normalizeAndValidateAuditTypes('meta-tags,,alt-text,');
      expect(result).to.deep.equal({ auditTypes: ['meta-tags', 'alt-text'] });
    });

    it('returns empty array when input normalizes to empty array', () => {
      const result = normalizeAndValidateAuditTypes(',,,');
      expect(result).to.deep.equal({ auditTypes: [] });
    });
  });

  describe('enforceRateLimit()', () => {
    const logger = { info: sinon.stub(), error: sinon.stub() };
    let ctx;

    beforeEach(() => {
      ctx = {
        env: {},
        log: logger,
      };
      sinon.reset();
    });

    it('uses configured rate limit from env', async () => {
      const site = createMockSite(new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString());
      ctx.env.SANDBOX_AUDIT_RATE_LIMIT_HOURS = '2';
      const { allowed, skipped } = await enforceRateLimit(site, ['meta-tags'], ctx, logger);
      expect(allowed).to.deep.equal(['meta-tags']);
      expect(skipped).to.be.an('array').that.is.empty;
    });

    it('uses default rate limit when env var is not set', async () => {
      const site = createMockSite(new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString());
      delete ctx.env.SANDBOX_AUDIT_RATE_LIMIT_HOURS;
      const { allowed, skipped } = await enforceRateLimit(site, ['meta-tags'], ctx, logger);
      expect(allowed).to.deep.equal(['meta-tags']);
      expect(skipped).to.be.an('array').that.is.empty;
    });

    it('uses default rate limit when env var is not a valid number', async () => {
      const site = createMockSite(new Date().toISOString());
      ctx.env.SANDBOX_AUDIT_RATE_LIMIT_HOURS = 'not-a-number';
      const { allowed, skipped } = await enforceRateLimit(site, ['meta-tags'], ctx, logger);
      expect(allowed).to.deep.equal(['meta-tags']);
      expect(skipped).to.be.an('array').that.is.empty;
    });

    it('allows all audits when rate limit is 0', async () => {
      const site = createMockSite(new Date().toISOString());
      ctx.env.SANDBOX_AUDIT_RATE_LIMIT_HOURS = '0';
      const { allowed, skipped } = await enforceRateLimit(site, ['meta-tags'], ctx, logger);
      expect(allowed).to.deep.equal(['meta-tags']);
      expect(skipped).to.be.an('array').that.is.empty;
    });

    it('skips audit that is too recent', async () => {
      const recent = new Date();
      const site = createMockSite(recent.toISOString());
      ctx.env.SANDBOX_AUDIT_RATE_LIMIT_HOURS = '1';
      const { allowed, skipped, response } = await enforceRateLimit(site, ['meta-tags'], ctx, logger);
      expect(allowed).to.be.empty;
      expect(skipped).to.have.length(1);
      expect(skipped[0]).to.have.property('auditType', 'meta-tags');
      expect(response).to.exist;
      expect(response.status).to.equal(429);
    });

    it('allows audit older than window', async () => {
      const old = new Date(Date.now() - 3 * 60 * 60 * 1000); // 3 hours ago
      const site = createMockSite(old.toISOString());
      ctx.env.SANDBOX_AUDIT_RATE_LIMIT_HOURS = '1';
      const { allowed, skipped } = await enforceRateLimit(site, ['meta-tags'], ctx, logger);
      expect(allowed).to.deep.equal(['meta-tags']);
      expect(skipped).to.be.empty;
    });

    it('allows audit when no previous audit exists', async () => {
      const site = createMockSite(null); // No previous audit
      ctx.env.SANDBOX_AUDIT_RATE_LIMIT_HOURS = '1';
      const { allowed, skipped } = await enforceRateLimit(site, ['meta-tags'], ctx, logger);
      expect(allowed).to.deep.equal(['meta-tags']);
      expect(skipped).to.be.empty;
    });
  });

  describe('triggerAudits()', () => {
    let ctx;

    beforeEach(() => {
      ctx = {
        env: { AUDIT_JOBS_QUEUE_URL: 'https://sqs.url/queue' },
        sqs: { sendMessage: sinon.stub().resolves({ MessageId: 'test-id' }) },
        log: { info: sinon.stub(), error: sinon.stub() },
      };
      sinon.reset();
    });

    it('handles string auditType input', async () => {
      const site = {
        getId: () => 'site-123',
        getBaseURL: () => 'https://sandbox.example.com',
      };
      const configuration = {
        isHandlerEnabledForSite: () => true,
      };

      const res = await triggerAudits(site, configuration, 'meta-tags', ctx);
      expect(res.status).to.equal(200);
    });

    it('merges skippedDetail into results', async () => {
      const site = {
        getId: () => 'site-123',
        getBaseURL: () => 'https://sandbox.example.com',
      };

      const configuration = {
        isHandlerEnabledForSite: () => true,
      };

      const skipped = [{ auditType: 'alt-text', nextAllowedAt: new Date().toISOString(), minutesRemaining: 10 }];

      const res = await triggerAudits(site, configuration, ['meta-tags'], ctx, skipped);
      const body = await res.json();

      expect(body.results).to.be.an('array');
      expect(body.results.some((r) => r.auditType === 'alt-text' && r.status === 'skipped')).to.be.true;
    });

    it('returns badRequest when no audits enabled for site', async () => {
      const site = {
        getId: () => 'site-123',
        getBaseURL: () => 'https://sandbox.example.com',
      };

      const configuration = {
        isHandlerEnabledForSite: () => false, // all audits disabled
      };

      const res = await triggerAudits(site, configuration, null, ctx);
      expect(res.status).to.equal(400);
    });

    it('processes valid audit types (validation moved to controller level)', async () => {
      const site = {
        getId: () => 'site-123',
        getBaseURL: () => 'https://sandbox.example.com',
      };

      const configuration = {
        isHandlerEnabledForSite: () => true,
      };

      const res = await triggerAudits(site, configuration, ['meta-tags'], ctx);
      expect(res.status).to.equal(200);

      const body = await res.json();
      expect(body.results).to.have.length(1);
      expect(body.results[0]).to.include({ auditType: 'meta-tags', status: 'triggered' });
    });

    it('returns badRequest when input contains invalid audit types', async () => {
      const site = {
        getId: () => 'site-123',
        getBaseURL: () => 'https://sandbox.example.com',
      };

      const configuration = {
        isHandlerEnabledForSite: () => true,
      };

      const res = await triggerAudits(site, configuration, ['invalid-audit'], ctx);
      expect(res.status).to.equal(400);
      const body = await res.json();
      expect(body).to.have.property('message').that.includes('Invalid audit types');
    });

    it('filters out disabled audit types and proceeds with enabled ones', async () => {
      const site = {
        getId: () => 'site-123',
        getBaseURL: () => 'https://sandbox.example.com',
      };
      const configuration = {
        isHandlerEnabledForSite: (type) => type === 'meta-tags',
      };

      const res = await triggerAudits(site, configuration, ['meta-tags', 'alt-text'], ctx);
      expect(res.status).to.equal(200);
      const body = await res.json();
      const types = body.results.map((r) => r.auditType);
      expect(types).to.include('meta-tags');
      expect(types).not.to.include('alt-text');
    });

    it('runs allowed audits and includes skipped due to rate limit end-to-end', async () => {
      // meta-tags allowed (old), alt-text skipped (recent)
      const old = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
      const recent = new Date().toISOString();
      const site = {
        getId: () => 'site-123',
        getBaseURL: () => 'https://sandbox.example.com',
        getLatestAuditByAuditType: sinon.stub().callsFake((t) => (t === 'alt-text' ? { getAuditedAt: () => recent } : { getAuditedAt: () => old })),
      };
      ctx.env.SANDBOX_AUDIT_RATE_LIMIT_HOURS = '2';
      const configuration = { isHandlerEnabledForSite: () => true };

      const { allowed, skipped } = await enforceRateLimit(site, ['meta-tags', 'alt-text'], ctx, ctx.log);
      expect(allowed).to.include('meta-tags');
      expect(skipped.map((s) => s.auditType)).to.include('alt-text');

      const res = await triggerAudits(site, configuration, ['meta-tags', 'alt-text'], ctx, skipped);
      expect(res.status).to.equal(200);
      const body = await res.json();
      const triggered = body.results.find((r) => r.auditType === 'meta-tags');
      const hasSkippedAlt = body.results.some((r) => r.auditType === 'alt-text' && r.status === 'skipped');
      expect(triggered.status).to.equal('triggered');
      expect(hasSkippedAlt).to.be.true;
      const skippedAlt = body.results.find((r) => r.auditType === 'alt-text' && r.status === 'skipped');
      expect(skippedAlt).to.have.property('minutesRemaining');
    });
  });
});
