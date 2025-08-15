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
import { badRequest } from '@adobe/spacecat-shared-http-utils';
import { normalizeAuditTypes, enforceRateLimit } from '../../src/support/sandbox-audit-service.js';

// Helper to create a mock Site with controllable audit history
function createMockSite(lastAuditDateIso) {
  return {
    getId: () => 'site-123',
    getBaseURL: () => 'https://sandbox.example.com',
    getLatestAuditByAuditType: sinon.stub().callsFake(() => (lastAuditDateIso ? {
      getAuditedAt: () => lastAuditDateIso,
    } : null)),
  };
}

describe('sandbox-audit-service helpers', () => {
  describe('normalizeAuditTypes()', () => {
    it('returns null when input is undefined', () => {
      expect(normalizeAuditTypes(undefined)).to.equal(null);
    });

    it('returns same array when array provided', () => {
      const arr = ['a', 'b'];
      expect(normalizeAuditTypes(arr)).to.equal(arr);
    });

    it('splits comma-separated string', () => {
      expect(normalizeAuditTypes('a,b , c')).to.deep.equal(['a', 'b', 'c']);
    });
  });

  describe('enforceRateLimit()', () => {
    const logger = { info: () => {} };

    it('returns null when rate limit disabled (0 hours)', async () => {
      const site = createMockSite(new Date().toISOString());
      const result = await enforceRateLimit(site, ['meta-tags'], 0, logger);
      expect(result).to.equal(null);
    });

    it('returns badRequest when audit too recent', async () => {
      const recent = new Date();
      const site = createMockSite(recent.toISOString());
      const res = await enforceRateLimit(site, ['meta-tags'], 1, logger);
      expect(res.status).to.equal(badRequest().status);
    });

    it('returns null when audit older than window', async () => {
      const old = new Date(Date.now() - 3 * 60 * 60 * 1000); // 3 hours ago
      const site = createMockSite(old.toISOString());
      const res = await enforceRateLimit(site, ['meta-tags'], 1, logger);
      expect(res).to.equal(null);
    });
  });

  describe('triggerAudits()', () => {
    it('handles string auditType input', async () => {
      const ctx = {
        env: { AUDIT_JOBS_QUEUE_URL: 'https://sqs.url/queue' },
        sqs: { sendMessage: sinon.stub().resolves() },
        log: { info: () => {}, error: () => {} },
      };
      const site = {
        getId: () => 'site-123',
        getBaseURL: () => 'https://sandbox.example.com',
      };
      const configuration = {
        isHandlerEnabledForSite: () => true,
      };

      const { triggerAudits } = await import('../../src/support/sandbox-audit-service.js');
      const res = await triggerAudits(site, configuration, 'meta-tags', ctx, site.getBaseURL());
      expect(res.status).to.equal(200);
    });
  });
});
