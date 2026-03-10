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

import { expect } from 'chai';
import { PlgOnboardingDto } from '../../src/dto/plg-onboarding.js';

describe('PlgOnboardingDto', () => {
  it('converts a PlgOnboarding entity to JSON', () => {
    const onboarding = {
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
      getCompletedAt: () => '2026-03-09T15:00:00.000Z',
      getCreatedAt: () => '2026-03-09T12:00:00.000Z',
      getUpdatedAt: () => '2026-03-09T15:00:00.000Z',
    };

    const result = PlgOnboardingDto.toJSON(onboarding);

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
      completedAt: '2026-03-09T15:00:00.000Z',
      createdAt: '2026-03-09T12:00:00.000Z',
      updatedAt: '2026-03-09T15:00:00.000Z',
    });
  });

  it('includes error and botBlocker when set', () => {
    const onboarding = {
      getId: () => 'onboarding-456',
      getImsOrgId: () => 'XYZ789@AdobeOrg',
      getDomain: () => 'blocked.com',
      getBaseURL: () => 'https://www.blocked.com',
      getStatus: () => 'WAITING_FOR_IP_ALLOWLISTING',
      getSiteId: () => null,
      getOrganizationId: () => 'org-111',
      getSteps: () => ({ orgResolved: true }),
      getError: () => null,
      getBotBlocker: () => ({
        type: 'cloudflare',
        ipsToAllowlist: ['1.2.3.4'],
        userAgent: 'SpaceCat/1.0',
      }),
      getWaitlistReason: () => null,
      getCompletedAt: () => null,
      getCreatedAt: () => '2026-03-09T12:00:00.000Z',
      getUpdatedAt: () => '2026-03-09T12:05:00.000Z',
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
