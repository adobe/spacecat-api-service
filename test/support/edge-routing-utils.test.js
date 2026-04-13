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

import { expect, use } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import esmock from 'esmock';
import { CDN_TYPES } from '../../src/controllers/llmo/llmo-utils.js';

use(chaiAsPromised);
use(sinonChai);

describe('edge-routing-utils', () => {
  let sandbox;
  let log;
  let fetchStub;
  let calculateForwardedHostStub;
  let edgeUtils;

  beforeEach(async () => {
    sandbox = sinon.createSandbox();
    log = {
      info: sandbox.stub(),
      error: sandbox.stub(),
      warn: sandbox.stub(),
      debug: sandbox.stub(),
    };

    fetchStub = sandbox.stub();
    calculateForwardedHostStub = sandbox.stub();

    edgeUtils = await esmock('../../src/support/edge-routing-utils.js', {
      '@adobe/spacecat-shared-utils': {
        isObject: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
        isValidUrl: (v) => {
          try {
            return Boolean(new URL(v));
          } catch {
            return false;
          }
        },
        tracingFetch: fetchStub,
      },
      '@adobe/spacecat-shared-tokowaka-client': {
        calculateForwardedHost: calculateForwardedHostStub,
      },
    });
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('getHostnameWithoutWww', () => {
    it('returns hostname as-is when no www prefix', () => {
      expect(edgeUtils.getHostnameWithoutWww('https://example.com', log)).to.equal('example.com');
    });

    it('strips www prefix', () => {
      expect(edgeUtils.getHostnameWithoutWww('https://www.example.com', log)).to.equal('example.com');
    });

    it('adds https scheme when missing', () => {
      expect(edgeUtils.getHostnameWithoutWww('example.com', log)).to.equal('example.com');
    });

    it('lowercases the hostname', () => {
      expect(edgeUtils.getHostnameWithoutWww('https://WWW.EXAMPLE.COM', log)).to.equal('example.com');
    });

    it('throws and logs on invalid URL', () => {
      expect(() => edgeUtils.getHostnameWithoutWww('not a url !!', log)).to.throw('Error getting hostname from URL');
      expect(log.error).to.have.been.calledOnce;
    });
  });

  describe('probeSiteAndResolveDomain', () => {
    it('returns calculated domain on 2xx response with x-edgeoptimize-request-id header', async () => {
      fetchStub.resolves({
        ok: true,
        status: 200,
        headers: { has: (h) => h === 'x-edgeoptimize-request-id' },
      });
      calculateForwardedHostStub.returns('example.com');

      const domain = await edgeUtils.probeSiteAndResolveDomain('https://example.com', log);

      expect(domain).to.equal('example.com');
      expect(calculateForwardedHostStub).to.have.been.calledWith('https://example.com', log);
    });

    it('throws when 2xx response is missing x-edgeoptimize-request-id header', async () => {
      fetchStub.resolves({
        ok: true,
        status: 200,
        headers: { has: () => false },
      });

      await expect(edgeUtils.probeSiteAndResolveDomain('https://example.com', log))
        .to.be.rejectedWith('missing the x-edgeoptimize-request-id response header');
    });

    it('returns calculated domain from Location header on 301 to same root domain', async () => {
      fetchStub.resolves({
        ok: false,
        status: 301,
        headers: { get: (n) => (n === 'location' ? 'https://www.example.com/' : null) },
      });
      calculateForwardedHostStub.returns('www.example.com');

      const domain = await edgeUtils.probeSiteAndResolveDomain('https://example.com', log);

      expect(domain).to.equal('www.example.com');
      expect(calculateForwardedHostStub).to.have.been.calledWith('https://www.example.com/', log);
    });

    it('throws when 301 redirects to a different root domain', async () => {
      fetchStub.resolves({
        ok: false,
        status: 301,
        headers: { get: (n) => (n === 'location' ? 'https://other-domain.com/' : null) },
      });

      await expect(edgeUtils.probeSiteAndResolveDomain('https://example.com', log))
        .to.be.rejectedWith('does not match probe domain');
    });

    it('throws when probe returns non-2xx non-301 status', async () => {
      fetchStub.resolves({ ok: false, status: 404 });

      await expect(edgeUtils.probeSiteAndResolveDomain('https://example.com', log))
        .to.be.rejectedWith('did not return 2xx or 301');
    });

    it('propagates network errors from fetch', async () => {
      fetchStub.rejects(new Error('Connection refused'));

      await expect(edgeUtils.probeSiteAndResolveDomain('https://example.com', log))
        .to.be.rejectedWith('Connection refused');
    });
  });

  describe('EDGE_OPTIMIZE_CDN_STRATEGIES AEM_CS_FASTLY', () => {
    it('buildUrl trims trailing slashes and appends domain path', async () => {
      const mod = await import('../../src/support/edge-routing-utils.js');
      const s = mod.EDGE_OPTIMIZE_CDN_STRATEGIES[CDN_TYPES.AEM_CS_FASTLY];
      expect(s.buildUrl({ cdnRoutingUrl: 'https://cdn.example.com///' }, 'mysite.com'))
        .to.equal('https://cdn.example.com/mysite.com/edgeoptimize');
      expect(s.buildBody(true)).to.deep.equal({ enabled: true });
      expect(s.method).to.equal('POST');
    });
  });

  describe('parseEdgeRoutingConfig', () => {
    it('returns cdnConfig for a valid entry', () => {
      const configJson = JSON.stringify({
        'aem-cs-fastly': { cdnRoutingUrl: 'https://cdn.example.com' },
      });
      const result = edgeUtils.parseEdgeRoutingConfig(configJson, 'aem-cs-fastly');
      expect(result).to.deep.equal({ cdnRoutingUrl: 'https://cdn.example.com' });
    });

    it('throws SyntaxError on invalid JSON', () => {
      expect(() => edgeUtils.parseEdgeRoutingConfig('not-json', 'aem-cs-fastly'))
        .to.throw(SyntaxError);
    });

    it('throws when cdnType entry is missing from config', () => {
      const configJson = JSON.stringify({ 'other-cdn': { cdnRoutingUrl: 'https://cdn.example.com' } });
      expect(() => edgeUtils.parseEdgeRoutingConfig(configJson, 'aem-cs-fastly'))
        .to.throw('missing entry or invalid URL');
    });

    it('throws when cdnRoutingUrl is not a valid URL', () => {
      const configJson = JSON.stringify({ 'aem-cs-fastly': { cdnRoutingUrl: 'not-a-url' } });
      expect(() => edgeUtils.parseEdgeRoutingConfig(configJson, 'aem-cs-fastly'))
        .to.throw('missing entry or invalid URL');
    });

    it('throws when cdnConfig entry is not an object', () => {
      const configJson = JSON.stringify({ 'aem-cs-fastly': 'string-value' });
      expect(() => edgeUtils.parseEdgeRoutingConfig(configJson, 'aem-cs-fastly'))
        .to.throw('missing entry or invalid URL');
    });
  });

  describe('callCdnRoutingApi', () => {
    const strategy = {
      buildUrl: (cdnConfig, domain) => `${cdnConfig.cdnRoutingUrl}/${domain}/edgeoptimize`,
      buildBody: (enabled) => ({ enabled }),
      method: 'POST',
    };
    const cdnConfig = { cdnRoutingUrl: 'https://cdn.example.com' };
    const domain = 'example.com';
    const spToken = 'test-sp-token';

    it('resolves without error on successful CDN API response', async () => {
      fetchStub.resolves({ ok: true });

      await expect(
        edgeUtils.callCdnRoutingApi(strategy, cdnConfig, domain, spToken, true, log),
      ).to.be.fulfilled;

      expect(fetchStub).to.have.been.calledOnce;
      const [url, opts] = fetchStub.firstCall.args;
      expect(url).to.equal('https://cdn.example.com/example.com/edgeoptimize');
      expect(JSON.parse(opts.body)).to.deep.equal({ enabled: true });
      expect(opts.headers.Authorization).to.equal('Bearer test-sp-token');
    });

    it('throws Error mentioning status when CDN responds 403', async () => {
      fetchStub.resolves({
        ok: false,
        status: 403,
        text: sandbox.stub().resolves('forbidden'),
      });

      await expect(
        edgeUtils.callCdnRoutingApi(strategy, cdnConfig, domain, spToken, true, log),
      ).to.be.rejectedWith(Error, /403/);
    });

    it('throws Error mentioning status when CDN responds 401', async () => {
      fetchStub.resolves({
        ok: false,
        status: 401,
        text: sandbox.stub().resolves('unauthorized'),
      });

      await expect(
        edgeUtils.callCdnRoutingApi(strategy, cdnConfig, domain, spToken, true, log),
      ).to.be.rejectedWith(Error, /401/);
    });

    it('throws Error mentioning status on other non-OK CDN responses', async () => {
      fetchStub.resolves({
        ok: false,
        status: 503,
        text: sandbox.stub().resolves('unavailable'),
      });

      await expect(
        edgeUtils.callCdnRoutingApi(strategy, cdnConfig, domain, spToken, true, log),
      ).to.be.rejectedWith(Error, /503/);
    });

    it('propagates network errors from fetch', async () => {
      fetchStub.rejects(new Error('Network failure'));

      await expect(
        edgeUtils.callCdnRoutingApi(strategy, cdnConfig, domain, spToken, true, log),
      ).to.be.rejectedWith('Network failure');
    });

    it('passes enabled=false to the CDN body when routing is disabled', async () => {
      fetchStub.resolves({ ok: true });

      await edgeUtils.callCdnRoutingApi(strategy, cdnConfig, domain, spToken, false, log);

      expect(JSON.parse(fetchStub.firstCall.args[1].body)).to.deep.equal({ enabled: false });
    });
  });

  describe('detectCdnForDomain', () => {
    let dnsPromises;
    let edgeUtilsDns;

    beforeEach(async () => {
      dnsPromises = {
        resolveCname: sandbox.stub(),
        resolve4: sandbox.stub(),
      };
      edgeUtilsDns = await esmock('../../src/support/edge-routing-utils.js', {
        dns: { promises: dnsPromises },
        '@adobe/spacecat-shared-utils': {
          isObject: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
          isValidUrl: (v) => {
            try {
              return Boolean(new URL(v));
            } catch {
              return false;
            }
          },
          tracingFetch: sandbox.stub(),
        },
        '@adobe/spacecat-shared-tokowaka-client': {
          calculateForwardedHost: sandbox.stub(),
        },
      });
    });

    it('returns null when DNS yields no AEM CS Fastly signals', async () => {
      dnsPromises.resolveCname.resolves([]);
      dnsPromises.resolve4.resolves([]);
      const result = await edgeUtilsDns.detectCdnForDomain('example.com');
      expect(result).to.equal(null);
    });

    it('returns aem-cs-fastly when host CNAME matches Adobe AEM cloud pattern', async () => {
      dnsPromises.resolveCname.withArgs('example.com').resolves(['origin.example.cdn.adobeaemcloud.com']);
      dnsPromises.resolve4.resolves([]);
      const result = await edgeUtilsDns.detectCdnForDomain('example.com');
      expect(result).to.equal(CDN_TYPES.AEM_CS_FASTLY);
    });

    it('returns aem-cs-fastly when A record matches known Fastly IP', async () => {
      dnsPromises.resolveCname.resolves([]);
      dnsPromises.resolve4.withArgs('example.com').resolves(['151.101.131.10']);
      const result = await edgeUtilsDns.detectCdnForDomain('example.com');
      expect(result).to.equal(CDN_TYPES.AEM_CS_FASTLY);
    });

    it('logs CNAME and A-record diagnostics when log is provided (covers log?.info branches)', async () => {
      const dnsLog = { info: sandbox.stub() };
      dnsPromises.resolveCname.withArgs('example.com').resolves(['unrelated-cname.example.com']);
      dnsPromises.resolve4.withArgs('example.com').resolves(['8.8.8.8']);
      const result = await edgeUtilsDns.detectCdnForDomain('example.com', dnsLog);
      expect(result).to.equal(null);
      expect(dnsLog.info).to.have.been.calledThrice;
      expect(dnsLog.info.secondCall.args[0]).to.include('CNAMES');
      expect(dnsLog.info.thirdCall.args[0]).to.include('IPs');
    });
  });

  describe('detectCdnForDomain (integration)', () => {
    const badDomain = () => ({
      toString() {
        throw new Error('bad domain');
      },
    });

    it('returns null when domain stringification throws', async () => {
      const mod = await import('../../src/support/edge-routing-utils.js');
      const result = await mod.detectCdnForDomain(badDomain());
      expect(result).to.equal(null);
    });

    it('logs and returns null when domain stringification throws and log is provided', async () => {
      const mod = await import('../../src/support/edge-routing-utils.js');
      const errLog = { error: sandbox.stub() };
      const result = await mod.detectCdnForDomain(badDomain(), errLog);
      expect(result).to.equal(null);
      expect(errLog.error).to.have.been.calledOnceWith(
        'detectCdnForDomain error',
        sinon.match.instanceOf(Error),
      );
    });
  });
});
