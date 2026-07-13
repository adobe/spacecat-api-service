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

import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import esmock from 'esmock';

use(sinonChai);

describe('openMovePlgSiteModal action', () => {
  let openMovePlgSiteModal;
  let siteStub;
  let organizationStub;
  let entitlementStub;
  let siteEnrollmentStub;
  let lambdaContext;
  let reparentSiteProjectStub;
  let createEntitlementStub;
  let checkValidEntitlementStub;
  let tierClientCreateForOrgStub;

  const VALUE = {
    baseURL: 'https://example.com',
    siteId: 'site-123',
    imsOrgId: '1234@AdobeOrg',
    organizationId: 'org-new',
    channelId: 'C123',
    threadTs: '111.222',
    messageTs: '111.333',
  };

  beforeEach(async () => {
    siteStub = { findById: sinon.stub() };
    organizationStub = { findById: sinon.stub() };
    entitlementStub = { allByOrganizationId: sinon.stub().resolves([]) };
    siteEnrollmentStub = {
      allBySiteId: sinon.stub().resolves([]),
      create: sinon.stub().resolves({ getId: () => 'new-enrollment' }),
    };

    reparentSiteProjectStub = sinon.stub().resolves();
    createEntitlementStub = sinon.stub().resolves({ entitlement: { getTier: () => 'PRE_ONBOARD' } });
    checkValidEntitlementStub = sinon.stub().resolves({
      entitlement: { getId: () => 'ent-1', getTier: () => 'PRE_ONBOARD' },
    });
    tierClientCreateForOrgStub = sinon.stub().returns({
      createEntitlement: createEntitlementStub,
      checkValidEntitlement: checkValidEntitlementStub,
    });

    openMovePlgSiteModal = (await esmock('../../../../src/support/slack/actions/move-plg-site.js', {
      '../../../../src/support/slack/actions/set-ims-org-modal.js': {
        reparentSiteProject: reparentSiteProjectStub,
      },
      '@adobe/spacecat-shared-tier-client': { default: { createForOrg: tierClientCreateForOrgStub } },
    })).default;

    lambdaContext = {
      dataAccess: {
        Site: siteStub,
        Organization: organizationStub,
        Entitlement: entitlementStub,
        SiteEnrollment: siteEnrollmentStub,
      },
      log: { error: sinon.spy(), info: sinon.spy() },
    };
  });

  const makeSite = (overrides = {}) => ({
    getId: () => 'site-123',
    getSiteEnrollments: sinon.stub().resolves([]),
    setOrganizationId: sinon.stub(),
    save: sinon.stub().resolves(),
    ...overrides,
  });

  const makeOrg = () => ({ getId: () => 'org-new' });

  const invoke = async (value = VALUE) => {
    const handler = openMovePlgSiteModal(lambdaContext);
    const ack = sinon.stub().resolves();
    const client = {
      chat: {
        update: sinon.stub().resolves(),
        postMessage: sinon.stub().resolves(),
      },
    };
    const body = { actions: [{ value: JSON.stringify(value) }] };
    await handler({ ack, body, client });
    return { ack, client };
  };

  it('acknowledges the action', async () => {
    siteStub.findById.resolves(null);
    const { ack } = await invoke();
    expect(ack).to.have.been.calledOnce;
  });

  it('reports when the site no longer exists', async () => {
    siteStub.findById.resolves(null);
    const { client } = await invoke();
    const updateCall = client.chat.update.getCall(0);
    expect(updateCall.args[0].text).to.match(/no longer exists/);
  });

  it('reports when the target org no longer exists', async () => {
    siteStub.findById.resolves(makeSite());
    organizationStub.findById.resolves(null);
    const { client } = await invoke();
    const updateCall = client.chat.update.getCall(0);
    expect(updateCall.args[0].text).to.match(/Target organization .* no longer exists/);
  });

  it('revokes existing ASO enrollments before reassigning the org', async () => {
    const removeStub = sinon.stub().resolves();
    const site = makeSite({
      getSiteEnrollments: sinon.stub().resolves([
        {
          getId: () => 'enrollment-1',
          getEntitlement: sinon.stub().resolves({ getProductCode: () => 'ASO' }),
          remove: removeStub,
        },
      ]),
    });
    siteStub.findById.resolves(site);
    organizationStub.findById.resolves(makeOrg());
    entitlementStub.allByOrganizationId.resolves([
      { getProductCode: () => 'ASO', getTier: () => 'PRE_ONBOARD' },
    ]);

    await invoke();

    expect(removeStub).to.have.been.calledOnce;
    expect(site.setOrganizationId).to.have.been.calledOnceWith('org-new');
    expect(site.save).to.have.been.calledOnce;
    expect(removeStub.calledBefore(site.save)).to.be.true;
  });

  it('revokes non-ASO enrollments too before reassigning the org', async () => {
    const removeAso = sinon.stub().resolves();
    const removeLlmo = sinon.stub().resolves();
    const site = makeSite({
      getSiteEnrollments: sinon.stub().resolves([
        {
          getId: () => 'enrollment-aso',
          getEntitlement: sinon.stub().resolves({ getProductCode: () => 'ASO' }),
          remove: removeAso,
        },
        {
          getId: () => 'enrollment-llmo',
          getEntitlement: sinon.stub().resolves({ getProductCode: () => 'LLMO' }),
          remove: removeLlmo,
        },
      ]),
    });
    siteStub.findById.resolves(site);
    organizationStub.findById.resolves(makeOrg());
    entitlementStub.allByOrganizationId.resolves([
      { getProductCode: () => 'ASO', getTier: () => 'PRE_ONBOARD' },
    ]);

    await invoke();

    expect(removeAso).to.have.been.calledOnce;
    expect(removeLlmo).to.have.been.calledOnce;
    expect(site.save).to.have.been.calledOnce;
  });

  it('rejects if the target org now has a PAID entitlement', async () => {
    const site = makeSite();
    siteStub.findById.resolves(site);
    organizationStub.findById.resolves(makeOrg());
    entitlementStub.allByOrganizationId.resolves([
      { getProductCode: () => 'ASO', getTier: () => 'PAID' },
    ]);
    const { client } = await invoke();
    const updateCall = client.chat.update.getCall(0);
    expect(updateCall.args[0].text).to.match(/PAID entitlement/);
    expect(site.save).to.not.have.been.called;
  });

  it('sets FREE_TRIAL to PRE_ONBOARD before reassigning and binding the enrollment', async () => {
    const site = makeSite();
    siteStub.findById.resolves(site);
    organizationStub.findById.resolves(makeOrg());
    entitlementStub.allByOrganizationId.resolves([
      { getProductCode: () => 'ASO', getTier: () => 'FREE_TRIAL' },
    ]);

    const { client } = await invoke();

    expect(tierClientCreateForOrgStub).to.have.been.called;
    expect(createEntitlementStub).to.have.been.calledWith('PRE_ONBOARD');
    expect(site.save).to.have.been.calledOnce;
    expect(checkValidEntitlementStub).to.have.been.calledOnce;

    const updateCall = client.chat.update.getCall(0);
    expect(updateCall.args[0].text).to.match(/Moved site/);
    expect(updateCall.args[0].text).to.include('PRE_ONBOARD');
  });

  it('sets PLG to PRE_ONBOARD before reassigning and binding the enrollment', async () => {
    const site = makeSite();
    siteStub.findById.resolves(site);
    organizationStub.findById.resolves(makeOrg());
    entitlementStub.allByOrganizationId.resolves([
      { getProductCode: () => 'ASO', getTier: () => 'PLG' },
    ]);

    await invoke();

    expect(createEntitlementStub).to.have.been.calledWith('PRE_ONBOARD');
    expect(site.save).to.have.been.calledOnce;
  });

  it('sets a missing entitlement to PRE_ONBOARD before reassigning and binding the enrollment', async () => {
    const site = makeSite();
    siteStub.findById.resolves(site);
    organizationStub.findById.resolves(makeOrg());
    entitlementStub.allByOrganizationId.resolves([]);

    await invoke();

    expect(createEntitlementStub).to.have.been.calledWith('PRE_ONBOARD');
    expect(site.save).to.have.been.calledOnce;
  });

  it('skips the entitlement bump when target org is already PRE_ONBOARD', async () => {
    const site = makeSite();
    siteStub.findById.resolves(site);
    organizationStub.findById.resolves(makeOrg());
    entitlementStub.allByOrganizationId.resolves([
      { getProductCode: () => 'ASO', getTier: () => 'PRE_ONBOARD' },
    ]);

    await invoke();

    expect(createEntitlementStub).to.not.have.been.called;
    expect(site.save).to.have.been.calledOnce;
    expect(checkValidEntitlementStub).to.have.been.calledOnce;
  });

  it('re-parents the site project so it stays visible under the target org', async () => {
    const site = makeSite();
    siteStub.findById.resolves(site);
    organizationStub.findById.resolves(makeOrg());
    entitlementStub.allByOrganizationId.resolves([
      { getProductCode: () => 'ASO', getTier: () => 'PRE_ONBOARD' },
    ]);

    await invoke();

    expect(reparentSiteProjectStub).to.have.been.calledOnce;
    const callArgs = reparentSiteProjectStub.getCall(0).args[0];
    expect(callArgs.site).to.equal(site);
    expect(callArgs.targetOrgId).to.equal('org-new');
    expect(callArgs.baseURL).to.equal('https://example.com');
    expect(callArgs.lambdaContext).to.equal(lambdaContext);
    expect(callArgs.say).to.be.a('function');
    expect(reparentSiteProjectStub.calledBefore(site.save)).to.be.true;
  });

  it('reuses an existing site enrollment for the entitlement instead of creating a new one', async () => {
    siteEnrollmentStub.allBySiteId.resolves([
      { getEntitlementId: () => 'ent-1' },
    ]);
    siteStub.findById.resolves(makeSite());
    organizationStub.findById.resolves(makeOrg());
    entitlementStub.allByOrganizationId.resolves([
      { getProductCode: () => 'ASO', getTier: () => 'PRE_ONBOARD' },
    ]);

    await invoke();

    expect(siteEnrollmentStub.create).to.not.have.been.called;
  });

  it('creates a new site enrollment when none matches the entitlement', async () => {
    siteEnrollmentStub.allBySiteId.resolves([]);
    siteStub.findById.resolves(makeSite());
    organizationStub.findById.resolves(makeOrg());
    entitlementStub.allByOrganizationId.resolves([
      { getProductCode: () => 'ASO', getTier: () => 'PRE_ONBOARD' },
    ]);

    await invoke();

    expect(siteEnrollmentStub.create).to.have.been.calledWith({
      siteId: 'site-123',
      entitlementId: 'ent-1',
    });
  });

  it('reports failure when reparenting/saving throws', async () => {
    const site = makeSite({ save: sinon.stub().rejects(new Error('db down')) });
    siteStub.findById.resolves(site);
    organizationStub.findById.resolves(makeOrg());

    const { client } = await invoke();
    const updateCall = client.chat.update.getCall(0);
    expect(updateCall.args[0].text).to.match(/Failed to move site/);
    expect(lambdaContext.log.error).to.have.been.called;
  });

  it('reports failure when no entitlement can be bound after reassignment', async () => {
    checkValidEntitlementStub.resolves({});
    siteStub.findById.resolves(makeSite());
    organizationStub.findById.resolves(makeOrg());
    entitlementStub.allByOrganizationId.resolves([
      { getProductCode: () => 'ASO', getTier: () => 'PRE_ONBOARD' },
    ]);

    const { client } = await invoke();
    const updateCall = client.chat.update.getCall(0);
    expect(updateCall.args[0].text).to.match(/Failed to move site/);
  });
});
