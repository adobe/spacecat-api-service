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
import {
  extractHelixConfigFromPreviewUrl,
  getPreflightMissingConfigLabels,
  isContentSourcePathRequired,
  isCSAuthoringType,
  isPreflightSiteConfigReady,
  promptPreflightConfig,
  toExternalDeliveryIds,
} from '../../../../src/support/slack/preflight/preflight-config.js';

describe('preflight-config helpers', () => {
  const sandbox = sinon.createSandbox();

  afterEach(() => {
    sandbox.restore();
  });

  describe('toExternalDeliveryIds', () => {
    it('maps program and environment IDs to external IDs', () => {
      expect(toExternalDeliveryIds('12345', '67890')).to.deep.equal({
        externalOwnerId: 'p12345',
        externalSiteId: 'e67890',
      });
    });
  });

  describe('isCSAuthoringType', () => {
    it('returns true for cs and cs/crosswalk', () => {
      expect(isCSAuthoringType('cs')).to.be.true;
      expect(isCSAuthoringType('cs/crosswalk')).to.be.true;
      expect(isCSAuthoringType('ams')).to.be.false;
    });
  });

  describe('extractHelixConfigFromPreviewUrl', () => {
    it('parses a valid helix preview URL', () => {
      expect(extractHelixConfigFromPreviewUrl('https://main--site--owner.hlx.live')).to.deep.equal({
        hlxVersion: 5,
        rso: {
          ref: 'main',
          site: 'site',
          owner: 'owner',
          tld: 'hlx.live',
        },
      });
    });

    it('returns null for invalid helix preview URL', () => {
      expect(extractHelixConfigFromPreviewUrl('https://invalid.example.com')).to.be.null;
    });
  });

  describe('getPreflightMissingConfigLabels', () => {
    it('flags missing authoring type and preview URL', () => {
      const site = {
        getAuthoringType: () => null,
        getDeliveryConfig: () => ({}),
        getHlxConfig: () => ({}),
      };

      expect(getPreflightMissingConfigLabels(site)).to.deep.equal([
        'Authoring Type',
        'Preview URL',
      ]);
    });

    it('flags missing AEM CS preview URL for cs authoring type', () => {
      const site = {
        getAuthoringType: () => 'cs',
        getDeliveryConfig: () => ({}),
        getHlxConfig: () => ({}),
      };

      expect(getPreflightMissingConfigLabels(site)).to.deep.equal(['AEM CS Preview URL']);
    });

    it('flags missing helix preview URL for document authoring type', () => {
      const site = {
        getAuthoringType: () => 'documentauthoring',
        getDeliveryConfig: () => ({}),
        getHlxConfig: () => ({}),
      };

      expect(getPreflightMissingConfigLabels(site)).to.deep.equal(['Helix Preview URL']);
    });

    it('returns no missing labels when document authoring has helix config', () => {
      const site = {
        getAuthoringType: () => 'documentauthoring',
        getDeliveryConfig: () => ({}),
        getHlxConfig: () => ({
          rso: {
            ref: 'main',
            site: 'site',
            owner: 'owner',
            tld: 'hlx.live',
          },
        }),
      };

      expect(getPreflightMissingConfigLabels(site)).to.deep.equal([]);
    });

    it('flags missing AMS URL for ams authoring type', () => {
      const site = {
        getAuthoringType: () => 'ams',
        getDeliveryConfig: () => ({}),
        getHlxConfig: () => ({}),
      };

      expect(getPreflightMissingConfigLabels(site)).to.deep.equal(['AMS URL']);
    });
  });

  describe('promptPreflightConfig', () => {
    it('posts a configuration prompt with missing items and open modal button', async () => {
      const site = {
        getId: () => 'site1',
        getBaseURL: () => 'https://example.com',
        getAuthoringType: () => 'ams',
        getDeliveryConfig: () => ({}),
        getHlxConfig: () => ({}),
      };
      const say = sandbox.stub().resolves();
      const slackContext = { say };

      await promptPreflightConfig(slackContext, site, 'preflight');

      expect(say).to.have.been.calledOnce;
      const message = say.firstCall.args[0];
      expect(message.text).to.include('https://example.com');
      expect(message.blocks[0].text.text).to.include('*Missing:*');
      expect(message.blocks[0].text.text).to.include('AMS URL');
      expect(message.blocks[1].elements[0].action_id).to.equal('open_preflight_config');
      expect(JSON.parse(message.blocks[1].elements[0].value)).to.deep.equal({
        siteId: 'site1',
        auditType: 'preflight',
      });
    });
  });

  describe('isContentSourcePathRequired', () => {
    it('returns false when program or environment ID is missing', async () => {
      const site = {
        getId: () => 'site1',
        getOrganizationId: () => 'org1',
      };
      const dataAccess = { Site: { allByExternalOwnerIdAndExternalSiteId: sandbox.stub() } };

      expect(await isContentSourcePathRequired(dataAccess, site, '', '67890', 'cs')).to.be.false;
      expect(dataAccess.Site.allByExternalOwnerIdAndExternalSiteId.called).to.be.false;
    });

    it('returns false for non-CS authoring types', async () => {
      const site = {
        getId: () => 'site1',
        getOrganizationId: () => 'org1',
      };
      const dataAccess = { Site: { allByExternalOwnerIdAndExternalSiteId: sandbox.stub() } };

      expect(await isContentSourcePathRequired(dataAccess, site, '12345', '67890', 'ams')).to.be.false;
      expect(dataAccess.Site.allByExternalOwnerIdAndExternalSiteId.called).to.be.false;
    });

    it('returns true when another cs site in the same org shares program and environment', async () => {
      const site = {
        getId: () => 'site1',
        getOrganizationId: () => 'org1',
        getAuthoringType: () => 'cs',
      };
      const dataAccess = {
        Site: {
          allByExternalOwnerIdAndExternalSiteId: sandbox.stub().resolves([
            site,
            {
              getId: () => 'site2',
              getOrganizationId: () => 'org1',
              getAuthoringType: () => 'cs',
            },
            {
              getId: () => 'site3',
              getOrganizationId: () => 'org2',
              getAuthoringType: () => 'cs',
            },
          ]),
        },
      };

      expect(await isContentSourcePathRequired(dataAccess, site, '12345', '67890', 'cs')).to.be.true;
      expect(dataAccess.Site.allByExternalOwnerIdAndExternalSiteId).to.have.been.calledWith('p12345', 'e67890');
    });

    it('returns true when another cs/crosswalk site shares program and environment', async () => {
      const site = {
        getId: () => 'site1',
        getOrganizationId: () => 'org1',
        getAuthoringType: () => 'cs/crosswalk',
      };
      const dataAccess = {
        Site: {
          allByExternalOwnerIdAndExternalSiteId: sandbox.stub().resolves([
            site,
            {
              getId: () => 'site2',
              getOrganizationId: () => 'org1',
              getAuthoringType: () => 'cs/crosswalk',
            },
          ]),
        },
      };

      expect(await isContentSourcePathRequired(dataAccess, site, '12345', '67890', 'cs/crosswalk')).to.be.true;
    });

    it('returns false when only a different authoring type shares program and environment', async () => {
      const site = {
        getId: () => 'site1',
        getOrganizationId: () => 'org1',
        getAuthoringType: () => 'cs',
      };
      const dataAccess = {
        Site: {
          allByExternalOwnerIdAndExternalSiteId: sandbox.stub().resolves([
            site,
            {
              getId: () => 'site2',
              getOrganizationId: () => 'org1',
              getAuthoringType: () => 'cs/crosswalk',
            },
          ]),
        },
      };

      expect(await isContentSourcePathRequired(dataAccess, site, '12345', '67890', 'cs')).to.be.false;
    });

    it('returns false when only the current site shares program and environment in the org', async () => {
      const site = {
        getId: () => 'site1',
        getOrganizationId: () => 'org1',
        getAuthoringType: () => 'cs',
      };
      const dataAccess = {
        Site: {
          allByExternalOwnerIdAndExternalSiteId: sandbox.stub().resolves([site]),
        },
      };

      expect(await isContentSourcePathRequired(dataAccess, site, '12345', '67890', 'cs')).to.be.false;
    });
  });

  describe('isPreflightSiteConfigReady', () => {
    it('returns not ready with needsContentSourcePath false when base config is missing', async () => {
      const site = {
        getAuthoringType: () => 'documentauthoring',
        getDeliveryConfig: () => ({}),
        getHlxConfig: () => ({}),
      };
      const context = {
        dataAccess: {
          Site: { allByExternalOwnerIdAndExternalSiteId: sandbox.stub() },
        },
      };

      const result = await isPreflightSiteConfigReady(site, context);

      expect(result.ready).to.be.false;
      expect(result.needsContentSourcePath).to.be.false;
      expect(result.missingLabels).to.deep.equal(['Helix Preview URL']);
      expect(context.dataAccess.Site.allByExternalOwnerIdAndExternalSiteId.called).to.be.false;
    });

    it('returns not ready when CS site is missing content source path and siblings exist', async () => {
      const site = {
        getId: () => 'site1',
        getOrganizationId: () => 'org1',
        getAuthoringType: () => 'cs',
        getDeliveryConfig: () => ({
          programId: '12345',
          environmentId: '67890',
        }),
        getHlxConfig: () => ({}),
      };
      const context = {
        dataAccess: {
          Site: {
            allByExternalOwnerIdAndExternalSiteId: sandbox.stub().resolves([
              site,
              {
                getId: () => 'site2',
                getOrganizationId: () => 'org1',
                getAuthoringType: () => 'cs',
              },
            ]),
          },
        },
      };

      const result = await isPreflightSiteConfigReady(site, context);
      expect(result.ready).to.be.false;
      expect(result.needsContentSourcePath).to.be.true;
      expect(result.missingLabels).to.deep.equal(['Content Source Path']);
    });

    it('returns not ready when CS/Crosswalk site is missing content source path and siblings exist', async () => {
      const site = {
        getId: () => 'site1',
        getOrganizationId: () => 'org1',
        getAuthoringType: () => 'cs/crosswalk',
        getDeliveryConfig: () => ({
          programId: '12345',
          environmentId: '67890',
        }),
        getHlxConfig: () => ({}),
      };
      const context = {
        dataAccess: {
          Site: {
            allByExternalOwnerIdAndExternalSiteId: sandbox.stub().resolves([
              site,
              {
                getId: () => 'site2',
                getOrganizationId: () => 'org1',
                getAuthoringType: () => 'cs/crosswalk',
              },
            ]),
          },
        },
      };

      const result = await isPreflightSiteConfigReady(site, context);
      expect(result.ready).to.be.false;
      expect(result.needsContentSourcePath).to.be.true;
    });

    it('returns ready when CS site has all required config including content source path', async () => {
      const site = {
        getId: () => 'site1',
        getOrganizationId: () => 'org1',
        getAuthoringType: () => 'cs',
        getDeliveryConfig: () => ({
          programId: '12345',
          environmentId: '67890',
          contentSourcePath: '/content/mysite',
        }),
        getHlxConfig: () => ({}),
      };
      const context = {
        dataAccess: {
          Site: {
            allByExternalOwnerIdAndExternalSiteId: sandbox.stub().resolves([
              site,
              {
                getId: () => 'site2',
                getOrganizationId: () => 'org1',
                getAuthoringType: () => 'cs',
              },
            ]),
          },
        },
      };

      const result = await isPreflightSiteConfigReady(site, context);
      expect(result.ready).to.be.true;
    });
  });
});
