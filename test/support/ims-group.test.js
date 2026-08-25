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
import sinon from 'sinon';
import { isImsGroupMember } from '../../src/support/ims-group.js';

describe('ims-group', () => {
  let sandbox;
  let log;
  let getImsUserOrganizations;
  let context;

  const IMS_ORG_ID = '12345@AdobeOrg';
  const GROUP_NAME = 'ASO-EDS-Autofix-users';
  const TOKEN = 'ims-user-token';

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    log = { info: sandbox.stub(), warn: sandbox.stub(), error: sandbox.stub() };
    getImsUserOrganizations = sandbox.stub();
    context = { imsClient: { getImsUserOrganizations } };
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('isImsGroupMember', () => {
    it('returns true when the caller belongs to the group in the matching org', async () => {
      getImsUserOrganizations.resolves([{
        orgRef: { ident: '12345', authSrc: 'AdobeOrg' },
        groups: [{ groupName: 'Other' }, { groupName: GROUP_NAME }],
      }]);

      const result = await isImsGroupMember(context, {
        imsOrgId: IMS_ORG_ID, imsUserToken: TOKEN, groupName: GROUP_NAME,
      }, log);

      expect(result).to.equal(true);
      expect(getImsUserOrganizations).to.have.been.calledOnceWithExactly(TOKEN);
    });

    it('matches the group name case-insensitively', async () => {
      getImsUserOrganizations.resolves([{
        orgRef: { ident: '12345', authSrc: 'AdobeOrg' },
        groups: [{ groupName: 'aso-eds-autofix-users' }],
      }]);

      const result = await isImsGroupMember(context, {
        imsOrgId: IMS_ORG_ID, imsUserToken: TOKEN, groupName: GROUP_NAME,
      }, log);

      expect(result).to.equal(true);
    });

    it('returns false when the caller is not in the group', async () => {
      getImsUserOrganizations.resolves([{
        orgRef: { ident: '12345', authSrc: 'AdobeOrg' },
        groups: [{ groupName: 'Other' }],
      }]);

      const result = await isImsGroupMember(context, {
        imsOrgId: IMS_ORG_ID, imsUserToken: TOKEN, groupName: GROUP_NAME,
      }, log);

      expect(result).to.equal(false);
    });

    it('returns false when no org matches the ims org id', async () => {
      getImsUserOrganizations.resolves([{
        orgRef: { ident: '99999', authSrc: 'AdobeOrg' },
        groups: [{ groupName: GROUP_NAME }],
      }]);

      const result = await isImsGroupMember(context, {
        imsOrgId: IMS_ORG_ID, imsUserToken: TOKEN, groupName: GROUP_NAME,
      }, log);

      expect(result).to.equal(false);
    });

    it('returns false when the matching org has no groups array', async () => {
      getImsUserOrganizations.resolves([{
        orgRef: { ident: '12345', authSrc: 'AdobeOrg' },
      }]);

      const result = await isImsGroupMember(context, {
        imsOrgId: IMS_ORG_ID, imsUserToken: TOKEN, groupName: GROUP_NAME,
      }, log);

      expect(result).to.equal(false);
    });

    it('returns false and logs when the IMS lookup throws (fail-closed)', async () => {
      getImsUserOrganizations.rejects(new Error('ims down'));

      const result = await isImsGroupMember(context, {
        imsOrgId: IMS_ORG_ID, imsUserToken: TOKEN, groupName: GROUP_NAME,
      }, log);

      expect(result).to.equal(false);
      expect(log.warn).to.have.been.calledWithMatch(/membership check failed/);
    });

    it('does not throw when no logger is supplied and the lookup fails', async () => {
      getImsUserOrganizations.rejects(new Error('ims down'));

      const result = await isImsGroupMember(context, {
        imsOrgId: IMS_ORG_ID, imsUserToken: TOKEN, groupName: GROUP_NAME,
      });

      expect(result).to.equal(false);
    });

    it('returns false without calling IMS when the user token is missing', async () => {
      const result = await isImsGroupMember(context, {
        imsOrgId: IMS_ORG_ID, imsUserToken: undefined, groupName: GROUP_NAME,
      }, log);

      expect(result).to.equal(false);
      expect(getImsUserOrganizations).to.not.have.been.called;
    });

    it('returns false without calling IMS when the ims org id is missing', async () => {
      const result = await isImsGroupMember(context, {
        imsOrgId: '', imsUserToken: TOKEN, groupName: GROUP_NAME,
      }, log);

      expect(result).to.equal(false);
      expect(getImsUserOrganizations).to.not.have.been.called;
    });

    it('returns false without calling IMS when the group name is missing', async () => {
      const result = await isImsGroupMember(context, {
        imsOrgId: IMS_ORG_ID, imsUserToken: TOKEN, groupName: '',
      }, log);

      expect(result).to.equal(false);
      expect(getImsUserOrganizations).to.not.have.been.called;
    });
  });
});
