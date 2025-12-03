/*
 * Copyright 2024 Adobe. All rights reserved.
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
import { AuditUrlDto } from '../../src/dto/audit-url.js';

describe('AuditUrlDto', () => {
  describe('toJSON', () => {
    it('converts an AuditUrl object to JSON', () => {
      const mockAuditUrl = {
        getAuditUrlId: () => 'au-123',
        getSiteId: () => 'site-123',
        getUrl: () => 'https://example.com/page1',
        getByCustomer: () => true,
        getAudits: () => ['accessibility', 'broken-backlinks'],
        getCreatedAt: () => '2025-01-01T00:00:00Z',
        getUpdatedAt: () => '2025-01-02T00:00:00Z',
        getCreatedBy: () => 'user-alice',
        getUpdatedBy: () => 'user-bob',
      };

      const result = AuditUrlDto.toJSON(mockAuditUrl);

      expect(result).to.deep.equal({
        auditUrlId: 'au-123',
        siteId: 'site-123',
        url: 'https://example.com/page1',
        byCustomer: true,
        audits: ['accessibility', 'broken-backlinks'],
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-02T00:00:00Z',
        createdBy: 'user-alice',
        updatedBy: 'user-bob',
      });
    });

    it('handles empty audits array', () => {
      const mockAuditUrl = {
        getAuditUrlId: () => 'au-456',
        getSiteId: () => 'site-456',
        getUrl: () => 'https://example.com/page2',
        getByCustomer: () => false,
        getAudits: () => [],
        getCreatedAt: () => '2025-01-01T00:00:00Z',
        getUpdatedAt: () => '2025-01-01T00:00:00Z',
        getCreatedBy: () => 'system',
        getUpdatedBy: () => 'system',
      };

      const result = AuditUrlDto.toJSON(mockAuditUrl);

      expect(result.audits).to.deep.equal([]);
      expect(result.byCustomer).to.equal(false);
    });

    it('handles null/undefined values from getters', () => {
      const mockAuditUrl = {
        getAuditUrlId: () => 'au-789',
        getSiteId: () => 'site-789',
        getUrl: () => 'https://example.com/page3',
        getByCustomer: () => undefined,
        getAudits: () => null,
        getCreatedAt: () => null,
        getUpdatedAt: () => undefined,
        getCreatedBy: () => undefined,
        getUpdatedBy: () => null,
      };

      const result = AuditUrlDto.toJSON(mockAuditUrl);

      expect(result.auditUrlId).to.equal('au-789');
      expect(result.siteId).to.equal('site-789');
      expect(result.url).to.equal('https://example.com/page3');
      expect(result.byCustomer).to.equal(undefined);
      expect(result.audits).to.equal(null);
    });
  });
});
