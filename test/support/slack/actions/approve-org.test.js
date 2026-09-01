/*
 * Copyright 2024 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */
import { use, expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import approveOrg from '../../../../src/support/slack/actions/approve-org.js';

use(chaiAsPromised);
use(sinonChai);

describe('approveOrg', () => {
  let context;
  let ackMock;
  let respondMock;
  let body;
  let site;
  let org;

  beforeEach(() => {
    ackMock = sinon.stub().resolves();
    respondMock = sinon.stub().resolves();

    site = {
      getId: () => 'site-id-1234',
      getBaseURL: () => 'https://spacecat.com',
      getOrganizationId: () => 'existing-org',
      getSiteEnrollments: sinon.stub().resolves([]),
      setOrganizationId: sinon.stub(),
      save: sinon.stub().resolves(),
    };

    org = {
      getId: () => 'org-id-5678',
    };

    context = {
      dataAccess: {
        Site: {
          findByBaseURL: sinon.stub(),
        },
        Organization: {
          findByImsOrgId: sinon.stub(),
        },
      },
      log: {
        info: sinon.stub(),
        error: sinon.stub(),
      },
    };

    // Slack body with a text that matches the "IMS org ID `ABC@AdobeOrg` ... <https://spacecat.com|" pattern
    body = {
      user: {
        username: 'test-user',
      },
      message: {
        blocks: [
          {
            block_id: 'some-block-id',
            text: {
              text: 'IMS org ID `ABC@AdobeOrg` was detected for <https://spacecat.com|spacecat.com>',
            },
          },
        ],
      },
    };
  });

  afterEach(() => {
    sinon.restore();
  });

  it('should approve org if message text includes an IMS org ID and a base URL', async () => {
    // Arrange
    context.dataAccess.Organization.findByImsOrgId.resolves(org);
    context.dataAccess.Site.findByBaseURL.resolves(site);

    const approveOrgAction = approveOrg(context);

    // Act
    await approveOrgAction({ ack: ackMock, body, respond: respondMock });

    // Assert
    expect(ackMock).to.have.been.calledOnce;
    expect(context.dataAccess.Organization.findByImsOrgId).to.have.been.calledWith('ABC@AdobeOrg');
    expect(context.dataAccess.Site.findByBaseURL).to.have.been.calledWith('https://spacecat.com');
    expect(site.setOrganizationId).to.have.been.calledWith(org.getId());
    expect(site.save).to.have.been.calledOnce;
    expect(respondMock).to.have.been.calledOnce;

    const respondArg = respondMock.firstCall.args[0];
    expect(respondArg.replace_original).to.be.true;
    expect(respondArg.blocks[1].text).to.deep.equal({
      text: 'Approved by @test-user :checked:',
      type: 'mrkdwn',
    });
  });

  it('responds actionably (no throw, no move) when the site cannot be resolved', async () => {
    // Site removed between the message being posted and the approval click: the guard's
    // contract needs a resolved site, so surface a reason instead of an opaque TypeError.
    context.dataAccess.Organization.findByImsOrgId.resolves(org);
    context.dataAccess.Site.findByBaseURL.resolves(null);

    const approveOrgAction = approveOrg(context);
    await approveOrgAction({ ack: ackMock, body, respond: respondMock });

    expect(site.setOrganizationId).to.not.have.been.called;
    expect(site.save).to.not.have.been.called;
    const texts = respondMock.getCalls().map((c) => c.args[0]?.text ?? '');
    expect(texts.some((t) => t.includes('no site found'))).to.be.true;
  });

  it('blocks the org approval when the site still has enrollments to orphan (LLMO-7284 AC12)', async () => {
    context.dataAccess.Organization.findByImsOrgId.resolves(org);
    context.dataAccess.Site.findByBaseURL.resolves(site);
    site.getSiteEnrollments = sinon.stub().resolves([{ getId: () => 'enr-1' }]);

    const approveOrgAction = approveOrg(context);

    let thrown;
    await approveOrgAction({ ack: ackMock, body, respond: respondMock })
      .catch((e) => {
        thrown = e;
      });

    // The reassignment is refused explicitly and the site's org is never changed.
    expect(thrown).to.be.an('error');
    expect(thrown.code).to.equal('site_org_reassignment_blocked');
    expect(site.setOrganizationId).to.not.have.been.called;
    expect(site.save).to.not.have.been.called;
    // LLMO-7284 (AC12): the operator is told, explicitly and actionably, why it was refused
    // (parity with set-ims-org-modal / onboard-llmo-modal) — not just a log entry.
    const respondTexts = respondMock.getCalls().map((c) => c.args[0]?.text ?? c.args[0]);
    expect(respondTexts.some((t) => typeof t === 'string' && t.includes(':x:') && t.includes('enrollment'))).to.equal(true);
  });

  it('should do nothing if IMS org ID and base URL are not found in the message text', async () => {
    // Arrange
    body.message.blocks[0].text.text = 'No IMS org ID here.';
    const approveOrgAction = approveOrg(context);

    // Act
    await approveOrgAction({ ack: ackMock, body, respond: respondMock });

    // Assert
    expect(ackMock).to.have.been.calledOnce;
    expect(context.dataAccess.Organization.findByImsOrgId).to.not.have.been.called;
    expect(context.dataAccess.Site.findByBaseURL).to.not.have.been.called;
    expect(respondMock).to.have.been.calledOnce;
  });

  it('should log error and rethrow if something goes wrong', async () => {
    // Arrange
    context.dataAccess.Organization.findByImsOrgId.rejects(new Error('DB error'));
    const approveOrgAction = approveOrg(context);

    // Act & Assert
    await expect(approveOrgAction({ ack: ackMock, body, respond: respondMock }))
      .to.be.rejectedWith('DB error');

    expect(context.log.error).to.have.been.calledWith('Error occurred while acknowledging org approval');
  });
});
