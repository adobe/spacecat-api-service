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
import { PlgOnboardingDto } from '../../src/dto/plg-onboarding.js';

describe('PlgOnboardingDto', () => {
  const baseOnboarding = {
    getId: () => 'onboarding-123',
    getImsOrgId: () => 'ABC123@AdobeOrg',
    getDomain: () => 'example.com',
    getBaseURL: () => 'https://www.example.com',
    getStatus: () => 'ONBOARDED',
    getSiteId: () => 'site-456',
    getOrganizationId: () => 'org-789',
    getSteps: () => ({ orgResolved: true, siteCreated: true }),
    getError: () => null,
    getBotBlocker: () => null,
    getWaitlistReason: () => null,
    getReviews: () => [
      {
        reason: 'AEM_SITE_CHECK',
        decision: 'BYPASSED',
        reviewedBy: 'reviewer@adobe.com',
        reviewedAt: '2026-03-09T14:00:00.000Z',
        justification: 'Verified manually',
      },
    ],
    getCompletedAt: () => '2026-03-09T15:00:00.000Z',
    getCreatedAt: () => '2026-03-09T12:00:00.000Z',
    getUpdatedAt: () => '2026-03-09T15:00:00.000Z',
    getUpdatedBy: () => 'user@example.com',
    getCreatedBy: () => 'creator@example.com',
  };

  describe('toJSON (public)', () => {
    it('excludes updatedBy and reviewedBy from reviews', () => {
      const result = PlgOnboardingDto.toJSON(baseOnboarding);

      expect(result).to.deep.equal({
        id: 'onboarding-123',
        imsOrgId: 'ABC123@AdobeOrg',
        domain: 'example.com',
        baseURL: 'https://www.example.com',
        status: 'ONBOARDED',
        siteId: 'site-456',
        organizationId: 'org-789',
        steps: { orgResolved: true, siteCreated: true },
        error: null,
        botBlocker: null,
        waitlistReason: null,
        reviews: [
          {
            reason: 'AEM_SITE_CHECK',
            decision: 'BYPASSED',
            reviewedAt: '2026-03-09T14:00:00.000Z',
            justification: 'Verified manually',
          },
        ],
        completedAt: '2026-03-09T15:00:00.000Z',
        createdAt: '2026-03-09T12:00:00.000Z',
        updatedAt: '2026-03-09T15:00:00.000Z',
      });

      expect(result).to.not.have.property('updatedBy');
      expect(result.reviews[0]).to.not.have.property('reviewedBy');
    });

    it('returns empty array for reviews when null', () => {
      const onboarding = { ...baseOnboarding, getReviews: () => null };
      const result = PlgOnboardingDto.toJSON(onboarding);
      expect(result.reviews).to.deep.equal([]);
    });

    it('includes error and botBlocker when set', () => {
      const onboarding = {
        ...baseOnboarding,
        getStatus: () => 'WAITING_FOR_IP_ALLOWLISTING',
        getSiteId: () => null,
        getBotBlocker: () => ({
          type: 'cloudflare',
          ipsToAllowlist: ['1.2.3.4'],
          userAgent: 'SpaceCat/1.0',
        }),
        getReviews: () => null,
        getCompletedAt: () => null,
      };

      const result = PlgOnboardingDto.toJSON(onboarding);

      expect(result.status).to.equal('WAITING_FOR_IP_ALLOWLISTING');
      expect(result.botBlocker).to.deep.equal({
        type: 'cloudflare',
        ipsToAllowlist: ['1.2.3.4'],
        userAgent: 'SpaceCat/1.0',
      });
      expect(result.siteId).to.be.null;
      expect(result.completedAt).to.be.null;
    });
  });

  describe('toAdminJSON (admin)', () => {
    it('includes updatedBy and full reviews with reviewedBy', () => {
      const result = PlgOnboardingDto.toAdminJSON(baseOnboarding);

      expect(result.updatedBy).to.equal('user@example.com');
      expect(result.reviews).to.deep.equal([
        {
          reason: 'AEM_SITE_CHECK',
          decision: 'BYPASSED',
          reviewedBy: 'reviewer@adobe.com',
          reviewedAt: '2026-03-09T14:00:00.000Z',
          justification: 'Verified manually',
        },
      ]);
    });

    it('includes all public fields in addition to admin fields', () => {
      const result = PlgOnboardingDto.toAdminJSON(baseOnboarding);

      expect(result).to.include({
        id: 'onboarding-123',
        imsOrgId: 'ABC123@AdobeOrg',
        domain: 'example.com',
        status: 'ONBOARDED',
        updatedBy: 'user@example.com',
      });
    });

    it('returns empty array for reviews when null', () => {
      const onboarding = { ...baseOnboarding, getReviews: () => null };
      const result = PlgOnboardingDto.toAdminJSON(onboarding);
      expect(result.reviews).to.deep.equal([]);
    });
  });
});
