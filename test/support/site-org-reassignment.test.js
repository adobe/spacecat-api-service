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
import sinon from 'sinon';
import { assertSiteOrgReassignmentSafe } from '../../src/support/site-org-reassignment.js';

describe('assertSiteOrgReassignmentSafe (LLMO-7284 AC12)', () => {
  const CURRENT_ORG = 'org-current';
  const TARGET_ORG = 'org-target';

  function makeSite({ orgId = CURRENT_ORG, enrollments = [] } = {}) {
    return {
      getId: () => 'site-1',
      getBaseURL: () => 'https://example.com',
      getOrganizationId: () => orgId,
      getSiteEnrollments: sinon.stub().resolves(enrollments),
    };
  }

  it('is a no-op when the target org equals the site current org (re-run with same org)', async () => {
    const site = makeSite({ orgId: TARGET_ORG, enrollments: [{}, {}] });
    await assertSiteOrgReassignmentSafe({ site, targetOrgId: TARGET_ORG });
    // enrollments are never even fetched for a same-org re-run
    expect(site.getSiteEnrollments).to.have.callCount(0);
  });

  it('passes when the site has no enrollments to orphan', async () => {
    const site = makeSite({ enrollments: [] });
    await assertSiteOrgReassignmentSafe({ site, targetOrgId: TARGET_ORG });
  });

  it('passes for a move to a brand-new org (null target) when enrollment-free', async () => {
    const site = makeSite({ enrollments: [] });
    await assertSiteOrgReassignmentSafe({ site, targetOrgId: null });
  });

  it('throws 409 site_org_reassignment_blocked when the move would orphan enrollments', async () => {
    const site = makeSite({ enrollments: [{ id: 'e1' }, { id: 'e2' }] });
    const err = await assertSiteOrgReassignmentSafe({ site, targetOrgId: TARGET_ORG })
      .catch((e) => e);
    expect(err).to.be.an('error');
    expect(err.status).to.equal(409);
    expect(err.code).to.equal('site_org_reassignment_blocked');
    expect(err.message).to.contain('2 enrollment');
  });

  it('blocks a move to a brand-new org (null target) when enrollments exist', async () => {
    const site = makeSite({ enrollments: [{ id: 'e1' }] });
    const err = await assertSiteOrgReassignmentSafe({ site, targetOrgId: null })
      .catch((e) => e);
    expect(err.status).to.equal(409);
    expect(err.code).to.equal('site_org_reassignment_blocked');
  });

  it('fails closed (502) when enrollments cannot be verified', async () => {
    const site = makeSite();
    site.getSiteEnrollments = sinon.stub().resolves(null);
    const err = await assertSiteOrgReassignmentSafe({ site, targetOrgId: TARGET_ORG })
      .catch((e) => e);
    expect(err.status).to.equal(502);
    expect(err.code).to.equal('site_org_reassignment_unverified');
  });
});
