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
    it('returns only id and baseURL when optional fields are not present', () => {
      const mockSite = {
        getId: () => 'a1b2c3d4-e5f6-7g8h-9i0j-k11l12m13n14',
        getBaseURL: () => 'https://example.com',
        getAuthoringType: () => undefined,
        getDeliveryConfig: () => undefined,
        getHlxConfig: () => undefined,
      };

      const result = SiteDto.toMinimalJSON(mockSite);

      expect(result).to.deep.equal({
        id: 'a1b2c3d4-e5f6-7g8h-9i0j-k11l12m13n14',
        baseURL: 'https://example.com',
      });
    });

    it('includes authoringType when present', () => {
      const mockSite = {
        getId: () => 'site-uuid-456',
        getBaseURL: () => 'https://example.com',
        getAuthoringType: () => 'aem_cs',
        getDeliveryConfig: () => undefined,
        getHlxConfig: () => undefined,
      };

      const result = SiteDto.toMinimalJSON(mockSite);

      expect(result).to.deep.equal({
        id: 'site-uuid-456',
        baseURL: 'https://example.com',
        authoringType: 'aem_cs',
      });
    });

    it('includes deliveryConfig.authorURL when present', () => {
      const mockSite = {
        getId: () => 'site-uuid-789',
        getBaseURL: () => 'https://example.com',
        getAuthoringType: () => undefined,
        getDeliveryConfig: () => ({ authorURL: 'https://author.example.com' }),
        getHlxConfig: () => undefined,
      };

      const result = SiteDto.toMinimalJSON(mockSite);

      expect(result).to.deep.equal({
        id: 'site-uuid-789',
        baseURL: 'https://example.com',
        deliveryConfig: {
          authorURL: 'https://author.example.com',
        },
      });
    });

    it('includes hlxConfig.rso.site when present', () => {
      const mockSite = {
        getId: () => 'site-uuid-abc',
        getBaseURL: () => 'https://example.com',
        getAuthoringType: () => undefined,
        getDeliveryConfig: () => undefined,
        getHlxConfig: () => ({ rso: { site: 'my-site' } }),
      };

      const result = SiteDto.toMinimalJSON(mockSite);

      expect(result).to.deep.equal({
        id: 'site-uuid-abc',
        baseURL: 'https://example.com',
        hlxConfig: {
          rso: {
            site: 'my-site',
          },
        },
      });
    });

    it('includes all optional fields when present', () => {
      const mockSite = {
        getId: () => 'site-uuid-full',
        getBaseURL: () => 'https://example.com',
        getAuthoringType: () => 'aem_cs',
        getDeliveryConfig: () => ({
          authorURL: 'https://author.example.com',
          otherField: 'ignored',
        }),
        getHlxConfig: () => ({
          rso: {
            site: 'my-site',
            owner: 'ignored',
          },
          otherField: 'ignored',
        }),
      };

      const result = SiteDto.toMinimalJSON(mockSite);

      expect(result).to.deep.equal({
        id: 'site-uuid-full',
        baseURL: 'https://example.com',
        authoringType: 'aem_cs',
        deliveryConfig: {
          authorURL: 'https://author.example.com',
        },
        hlxConfig: {
          rso: {
            site: 'my-site',
          },
        },
      });
    });
  });
});
