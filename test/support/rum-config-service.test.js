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

import { use, expect } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import esmock from 'esmock';

use(sinonChai);

describe('rum-config-service', () => {
  const sandbox = sinon.createSandbox();

  let updateRumConfig;
  let retrieveDomainkeyStub;
  let rumApiClientStub;
  let toDynamoItemStub;
  let site;
  let siteConfig;
  let context;

  before(async () => {
    retrieveDomainkeyStub = sandbox.stub();
    rumApiClientStub = { retrieveDomainkey: retrieveDomainkeyStub };
    toDynamoItemStub = sandbox.stub().returns({});

    ({ updateRumConfig } = await esmock('../../src/support/rum-config-service.js', {
      '@adobe/spacecat-shared-rum-api-client': {
        default: { createFrom: () => rumApiClientStub },
      },
      '@adobe/spacecat-shared-data-access/src/models/site/config.js': {
        Config: { toDynamoItem: toDynamoItemStub },
      },
    }));
  });

  beforeEach(() => {
    sandbox.reset();

    siteConfig = {
      updateRumConfig: sandbox.stub(),
    };

    site = {
      getId: sandbox.stub().returns('site-123'),
      getBaseURL: () => 'https://example.com',
      getConfig: () => siteConfig,
      setConfig: sandbox.stub(),
      save: sandbox.stub().resolves(),
    };

    context = { log: { warn: sandbox.stub() } };
  });

  describe('updateRumConfig', () => {
    it('sets hasDomainKey true and saves when RUM key is found', async () => {
      retrieveDomainkeyStub.resolves('dom-key-abc');

      const result = await updateRumConfig(site, context);

      expect(result).to.be.true;
      expect(siteConfig.updateRumConfig).to.have.been.calledOnceWith(true);
      expect(toDynamoItemStub).to.have.been.calledOnceWith(siteConfig);
      expect(site.setConfig).to.have.been.calledOnce;
      expect(site.save).to.have.been.calledOnce;
    });

    it('sets hasDomainKey false and saves when RUM API throws', async () => {
      retrieveDomainkeyStub.rejects(new Error('not found'));

      const result = await updateRumConfig(site, context);

      expect(result).to.be.false;
      expect(siteConfig.updateRumConfig).to.have.been.calledOnceWith(false);
      expect(toDynamoItemStub).to.have.been.calledOnceWith(siteConfig);
      expect(site.setConfig).to.have.been.calledOnce;
      expect(site.save).to.have.been.calledOnce;
      expect(context.log.warn).to.have.been.calledOnce;
    });

    it('sets hasDomainKey false and clears timer when RUM check times out', async () => {
      retrieveDomainkeyStub.returns(new Promise(() => {})); // never resolves

      const clock = sinon.useFakeTimers();
      const promise = updateRumConfig(site, context);
      await clock.tickAsync(4000);
      const result = await promise;
      clock.restore();

      expect(result).to.be.false;
      expect(siteConfig.updateRumConfig).to.have.been.calledOnceWith(false);
      expect(site.setConfig).to.have.been.calledOnce;
      expect(site.save).to.have.been.calledOnce;
    });

    it('skips config mutation and save when { save: false } is passed', async () => {
      retrieveDomainkeyStub.resolves('dom-key-abc');

      const result = await updateRumConfig(site, context, { save: false });

      expect(result).to.be.true;
      expect(siteConfig.updateRumConfig).to.not.have.been.called;
      expect(site.setConfig).to.not.have.been.called;
      expect(site.save).to.not.have.been.called;
    });

    it('extracts hostname from baseURL before passing to retrieveDomainkey', async () => {
      retrieveDomainkeyStub.resolves('key');

      await updateRumConfig(site, context);

      expect(retrieveDomainkeyStub).to.have.been.calledOnceWith('example.com');
    });
  });
});
