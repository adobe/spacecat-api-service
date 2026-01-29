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
import { getCustomerConfigByOrganizationId } from '../../src/support/customer-config-data.js';

describe('Customer Config Data', () => {
  describe('getCustomerConfigByOrganizationId', () => {
    it('returns null for unknown organization ID', () => {
      const result = getCustomerConfigByOrganizationId('unknown-org-id');
      expect(result).to.be.null;
    });

    it('returns null for empty organization ID', () => {
      const result = getCustomerConfigByOrganizationId('');
      expect(result).to.be.null;
    });

    it('returns null for null organization ID', () => {
      const result = getCustomerConfigByOrganizationId(null);
      expect(result).to.be.null;
    });

    it('returns null for undefined organization ID', () => {
      const result = getCustomerConfigByOrganizationId(undefined);
      expect(result).to.be.null;
    });
  });
});
