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
import { FeatureFlagDto } from '../../src/dto/feature-flag.js';

describe('FeatureFlagDto', () => {
  it('maps snake_case row to JSON', () => {
    const json = FeatureFlagDto.toJSON({
      id: 'uuid',
      organization_id: 'org',
      product: 'LLMO',
      flag_name: 'enable_x',
      flag_value: false,
      created_at: 'c',
      updated_at: 'u',
      updated_by: 'ims-123',
    });
    expect(json).to.deep.equal({
      id: 'uuid',
      organizationId: 'org',
      product: 'LLMO',
      flagName: 'enable_x',
      flagValue: false,
      createdAt: 'c',
      updatedAt: 'u',
      updatedBy: 'ims-123',
    });
  });

  it('maps null updated_by to null', () => {
    const json = FeatureFlagDto.toJSON({
      id: 'uuid',
      organization_id: 'org',
      product: 'ASO',
      flag_name: 'x',
      flag_value: true,
      created_at: 'c',
      updated_at: 'u',
      updated_by: null,
    });
    expect(json.updatedBy).to.be.null;
  });
});
