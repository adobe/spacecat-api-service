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
      getFetchConfig: sandbox.stub().returns({}),
      updateRumConfig: sandbox.stub(),
    };

    site = {
      getId: () => 'site-123',
      getBaseURL: () => 'https://example.com',
      getConfig: () => siteConfig,
      setConfig: sandbox.stub(),
      save: sandbox.stub().resolves(),
    };

    context = { log: { info: sandbox.stub(), warn: sandbox.stub() } };
  });

  describe('updateRumConfig', () => {
    it('sets hasDomainKey true and saves when RUM key is found on base hostname', async () => {
      retrieveDomainkeyStub.resolves('dom-key-abc');

      const result = await updateRumConfig(site, context);

      expect(result).to.be.true;
      expect(siteConfig.updateRumConfig).to.have.been.calledOnceWith(true);
      expect(toDynamoItemStub).to.have.been.calledOnceWith(siteConfig);
      expect(site.setConfig).to.have.been.calledOnce;
      expect(site.save).to.have.been.calledOnce;
    });

    it('falls back to www.example.com when example.com lookup fails', async () => {
      retrieveDomainkeyStub
        .withArgs('example.com').rejects(new Error('not found'))
        .withArgs('www.example.com').resolves('dom-key-www');

      const result = await updateRumConfig(site, context);

      expect(result).to.be.true;
      expect(retrieveDomainkeyStub).to.have.been.calledWith('example.com');
      expect(retrieveDomainkeyStub).to.have.been.calledWith('www.example.com');
      expect(siteConfig.updateRumConfig).to.have.been.calledOnceWith(true);
    });

    it('sets hasDomainKey false and saves when all candidates fail', async () => {
      retrieveDomainkeyStub.rejects(new Error('not found'));

      const result = await updateRumConfig(site, context);

      expect(result).to.be.false;
      expect(siteConfig.updateRumConfig).to.have.been.calledOnceWith(false);
      expect(toDynamoItemStub).to.have.been.calledOnceWith(siteConfig);
      expect(site.setConfig).to.have.been.calledOnce;
      expect(site.save).to.have.been.calledOnce;
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

    it('tries overrideBaseURL hostname first when set', async () => {
      siteConfig.getFetchConfig.returns({ overrideBaseURL: 'https://override.example.com' });
      retrieveDomainkeyStub
        .withArgs('override.example.com').resolves('dom-key-override');

      const result = await updateRumConfig(site, context);

      expect(result).to.be.true;
      expect(retrieveDomainkeyStub.firstCall.args[0]).to.equal('override.example.com');
      expect(retrieveDomainkeyStub).to.have.been.calledOnce;
    });

    it('falls back through override www, base, and base www when override bare fails', async () => {
      siteConfig.getFetchConfig.returns({ overrideBaseURL: 'https://override.example.com' });
      retrieveDomainkeyStub.withArgs('override.example.com')
        .rejects(new Error('not found'));
      retrieveDomainkeyStub.withArgs('www.override.example.com')
        .rejects(new Error('not found'));
      retrieveDomainkeyStub.withArgs('example.com')
        .rejects(new Error('not found'));
      retrieveDomainkeyStub.withArgs('www.example.com')
        .resolves('dom-key-www');

      const result = await updateRumConfig(site, context);

      expect(result).to.be.true;
      expect(retrieveDomainkeyStub.args.map((a) => a[0])).to.deep.equal([
        'override.example.com',
        'www.override.example.com',
        'example.com',
        'www.example.com',
      ]);
    });

    it('does not duplicate www candidate when overrideBaseURL already has www', async () => {
      siteConfig.getFetchConfig.returns({ overrideBaseURL: 'https://www.override.example.com' });
      retrieveDomainkeyStub.resolves('dom-key-www');

      await updateRumConfig(site, context);

      const calledDomains = retrieveDomainkeyStub.args.map((a) => a[0]);
      expect(calledDomains.filter((d) => d === 'www.override.example.com')).to.have.lengthOf(1);
    });

    it('falls back to baseURL when overrideBaseURL is malformed', async () => {
      siteConfig.getFetchConfig.returns({ overrideBaseURL: 'not-a-valid-url' });
      retrieveDomainkeyStub.resolves('dom-key-abc');

      const result = await updateRumConfig(site, context);

      expect(result).to.be.true;
      expect(context.log.warn).to.have.been.calledWithMatch(/Malformed overrideBaseURL/);
      expect(retrieveDomainkeyStub.firstCall.args[0]).to.equal('example.com');
    });

    it('does not add bare variant when baseURL already starts with www', async () => {
      site = { ...site, getBaseURL: () => 'https://www.example.com' };
      retrieveDomainkeyStub.resolves('dom-key-www');

      const result = await updateRumConfig(site, context);

      expect(result).to.be.true;
      const calledDomains = retrieveDomainkeyStub.args.map((a) => a[0]);
      expect(calledDomains).to.deep.equal(['www.example.com']);
    });

    it('stops iterating candidates once cancelled by timeout', async () => {
      let rejectFirst;
      retrieveDomainkeyStub.withArgs('example.com').returns(
        new Promise((_, reject) => { rejectFirst = reject; }),
      );
      retrieveDomainkeyStub.withArgs('www.example.com').resolves('dom-key-www');

      const clock = sinon.useFakeTimers();
      const resultPromise = updateRumConfig(site, context);

      await clock.tickAsync(4000); // fires timeout, sets cancelled=true
      clock.restore();

      rejectFirst(new Error('slow network'));
      // drain microtasks so inner IIFE processes the rejection and checks cancelled
      await new Promise(setImmediate);

      const result = await resultPromise;

      expect(result).to.be.false;
      expect(retrieveDomainkeyStub).to.have.been.calledOnce;
      expect(retrieveDomainkeyStub).not.to.have.been.calledWith('www.example.com');
    });
  });
});
