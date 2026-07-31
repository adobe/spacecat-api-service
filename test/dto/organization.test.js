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
import { Config } from '@adobe/spacecat-shared-data-access/src/models/site/config.js';
import { OrganizationDto } from '../../src/dto/organization.js';

const buildOrganization = () => ({
  getId: () => '9033554c-de8a-44ac-a356-09b51af8cc28',
  getName: () => 'Example Organization',
  getImsOrgId: () => '1234567890ABCDEF12345678@AdobeOrg',
  getSemrushWorkspaceId: () => 'ws_12345',
  getCreatedAt: () => '2023-12-15T09:30:00Z',
  getUpdatedAt: () => '2024-01-19T11:20:00Z',
  getConfig: () => Config({}),
});

const buildEntitlement = (productCode, tier) => ({
  getProductCode: () => productCode,
  getTier: () => tier,
});

describe('OrganizationDto', () => {
  it('maps the base organization fields without an entitlements array by default', () => {
    const json = OrganizationDto.toJSON(buildOrganization());

    expect(json).to.include({
      id: '9033554c-de8a-44ac-a356-09b51af8cc28',
      name: 'Example Organization',
      imsOrgId: '1234567890ABCDEF12345678@AdobeOrg',
      semrushWorkspaceId: 'ws_12345',
      createdAt: '2023-12-15T09:30:00Z',
      updatedAt: '2024-01-19T11:20:00Z',
    });
    expect(json).to.not.have.property('entitlements');
  });

  it('adds a compact per-product entitlements summary when entitlements are provided', () => {
    const json = OrganizationDto.toJSON(buildOrganization(), [
      buildEntitlement('LLMO', 'FREE_TRIAL'),
      buildEntitlement('ASO', 'PAID'),
    ]);

    expect(json.entitlements).to.deep.equal([
      { productCode: 'LLMO', tier: 'FREE_TRIAL' },
      { productCode: 'ASO', tier: 'PAID' },
    ]);
  });

  it('includes an empty entitlements array when an empty list is provided', () => {
    const json = OrganizationDto.toJSON(buildOrganization(), []);

    expect(json.entitlements).to.deep.equal([]);
  });

  it('omits entitlements when null is provided (list endpoint / lookup failure)', () => {
    const json = OrganizationDto.toJSON(buildOrganization(), null);

    expect(json).to.not.have.property('entitlements');
  });
});
