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
import { SiteIdentityDto } from '../../src/dto/site-identity.js';

describe('SiteIdentityDto', () => {
  const buildSite = ({
    id = '7511d4b9-1234-4abc-8def-0123456789ab',
    organizationId = '160da889-5678-4cde-9f01-23456789abcd',
    baseURL = 'https://example.com',
    deliveryType = 'aem_edge',
  } = {}) => ({
    getId: () => id,
    getOrganizationId: () => organizationId,
    getBaseURL: () => baseURL,
    getDeliveryType: () => deliveryType,
  });

  describe('toJSON', () => {
    it('exposes exactly the minimal routing identity surface', () => {
      const result = SiteIdentityDto.toJSON(buildSite(), '8C6043F15F43B6390A49401A@AdobeOrg');

      expect(result).to.deep.equal({
        siteId: '7511d4b9-1234-4abc-8def-0123456789ab',
        organizationId: '160da889-5678-4cde-9f01-23456789abcd',
        imsOrgId: '8C6043F15F43B6390A49401A@AdobeOrg',
        baseURL: 'https://example.com',
        deliveryType: 'aem_edge',
      });
    });

    it('does not leak any tenant fields beyond the frozen surface', () => {
      const result = SiteIdentityDto.toJSON(buildSite(), '8C6043F15F43B6390A49401A@AdobeOrg');

      expect(Object.keys(result)).to.have.members([
        'siteId', 'organizationId', 'imsOrgId', 'baseURL', 'deliveryType',
      ]);
    });

    it('normalizes a missing imsOrgId to null', () => {
      expect(SiteIdentityDto.toJSON(buildSite(), null).imsOrgId).to.equal(null);
      expect(SiteIdentityDto.toJSON(buildSite(), undefined).imsOrgId).to.equal(null);
    });

    it('normalizes a missing organizationId to null', () => {
      const orglessSite = {
        getId: () => '7511d4b9-1234-4abc-8def-0123456789ab',
        getOrganizationId: () => undefined,
        getBaseURL: () => 'https://example.com',
        getDeliveryType: () => 'aem_edge',
      };
      const result = SiteIdentityDto.toJSON(orglessSite, null);

      expect(result.organizationId).to.equal(null);
      expect(result.imsOrgId).to.equal(null);
    });
  });
});
