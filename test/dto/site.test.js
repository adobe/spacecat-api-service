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

/* eslint-env mocha */

import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';

import { SiteDto } from '../../src/dto/site.js';

use(chaiAsPromised);

describe('Site DTO', () => {
  describe('toMinimalJSON', () => {
    it('returns only id and baseURL', () => {
      const mockSite = {
        getId: () => 'a1b2c3d4-e5f6-7g8h-9i0j-k11l12m13n14',
        getBaseURL: () => 'https://example.com',
        getName: () => 'Example Site',
        getOrganizationId: () => 'org-123',
        getDeliveryType: () => 'aem_edge',
        getGitHubURL: () => 'https://github.com/example/repo',
        getIsLive: () => true,
        getIsSandbox: () => false,
        getCreatedAt: () => '2024-01-20T10:00:00Z',
        getUpdatedAt: () => '2024-01-20T10:00:00Z',
        getConfig: () => ({}),
      };

      const result = SiteDto.toMinimalJSON(mockSite);

      expect(result).to.deep.equal({
        id: 'a1b2c3d4-e5f6-7g8h-9i0j-k11l12m13n14',
        baseURL: 'https://example.com',
      });
      expect(result).to.not.have.property('name');
      expect(result).to.not.have.property('organizationId');
      expect(result).to.not.have.property('deliveryType');
    });

    it('handles sites with different baseURLs correctly', () => {
      const mockSite = {
        getId: () => 'site-uuid-123',
        getBaseURL: () => 'https://another-example.org',
      };

      const result = SiteDto.toMinimalJSON(mockSite);

      expect(result).to.deep.equal({
        id: 'site-uuid-123',
        baseURL: 'https://another-example.org',
      });
    });
  });
});
