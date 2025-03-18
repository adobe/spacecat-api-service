/*
 * Copyright 2025 Adobe. All rights reserved.
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
import { getDataAccess } from '../util/db.js';
import { seedDatabase } from '../util/seed.js';

describe('Role IT', async () => {
  let Role;

  before(async () => {
    await seedDatabase();

    const acls = [];
    const aclCtx = { acls };
    const dataAccess = getDataAccess({ aclCtx });
    Role = dataAccess.Role;
  });

  it('finds all matching roles', async () => {
    const roles = await Role.allRolesByIdentities(
      'DAADAADAA@AdobeOrg',
      ['imsOrgID:DAADAADAA@AdobeOrg', 'imsID:1234@5678.e'],
    );
    console.log('roles', roles);
    expect(roles).to.have.length(3);

    const roleNames = new Set(roles.map((role) => role.name));
    expect(roleNames).to.deep.equal(new Set(['foo-role', 'bar-role', 'far-role']));
  });
});
