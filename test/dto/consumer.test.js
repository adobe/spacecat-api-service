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
import { ConsumerDto } from '../../src/dto/consumer.js';

describe('ConsumerDto', () => {
  it('converts a consumer entity to JSON', () => {
    const consumer = {
      getClientId: () => 'client-123',
      getTechnicalAccountId: () => 'ta-456',
      getImsOrgId: () => 'org@AdobeOrg',
      getConsumerName: () => 'My Integration',
      getCapabilities: () => ['site:read', 'site:write'],
      getStatus: () => 'ACTIVE',
      getRevokedAt: () => null,
      getCreatedAt: () => '2026-01-15T10:00:00.000Z',
      getUpdatedAt: () => '2026-01-15T10:00:00.000Z',
      getUpdatedBy: () => 'admin@example.com',
    };

    const result = ConsumerDto.toJSON(consumer);

    expect(result).to.deep.equal({
      clientId: 'client-123',
      technicalAccountId: 'ta-456',
      imsOrgId: 'org@AdobeOrg',
      consumerName: 'My Integration',
      capabilities: ['site:read', 'site:write'],
      status: 'ACTIVE',
      revokedAt: null,
      createdAt: '2026-01-15T10:00:00.000Z',
      updatedAt: '2026-01-15T10:00:00.000Z',
      updatedBy: 'admin@example.com',
    });
  });

  it('includes revokedAt when set', () => {
    const consumer = {
      getClientId: () => 'client-123',
      getTechnicalAccountId: () => 'ta-456',
      getImsOrgId: () => 'org@AdobeOrg',
      getConsumerName: () => 'Revoked Integration',
      getCapabilities: () => ['site:read'],
      getStatus: () => 'REVOKED',
      getRevokedAt: () => '2026-12-31T23:59:59.000Z',
      getCreatedAt: () => '2026-01-15T10:00:00.000Z',
      getUpdatedAt: () => '2026-06-15T10:00:00.000Z',
      getUpdatedBy: () => 'admin@example.com',
    };

    const result = ConsumerDto.toJSON(consumer);

    expect(result.status).to.equal('REVOKED');
    expect(result.revokedAt).to.equal('2026-12-31T23:59:59.000Z');
  });
});
