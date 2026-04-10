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
import sinon from 'sinon';
import esmock from 'esmock';

describe('cdn-detection', () => {
  let sandbox;
  let detectCdnForDomain;
  let dnsStubs;

  beforeEach(async () => {
    sandbox = sinon.createSandbox();

    dnsStubs = {
      resolveCname: sandbox.stub(),
      resolve4: sandbox.stub(),
    };

    ({ detectCdnForDomain } = await esmock('../../src/support/cdn-detection.js', {
      dns: { promises: dnsStubs },
    }));
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('returns aem-cs-fastly when www subdomain CNAME matches', async () => {
    dnsStubs.resolveCname.withArgs('www.example.com').resolves(['cdn.adobeaemcloud.com.']);
    dnsStubs.resolve4.resolves([]);

    const result = await detectCdnForDomain('example.com');
    expect(result).to.equal('aem-cs-fastly');
  });

  it('returns aem-cs-fastly when bare domain CNAME matches', async () => {
    dnsStubs.resolveCname.withArgs('www.example.com').resolves([]);
    dnsStubs.resolve4.withArgs('www.example.com').resolves([]);
    dnsStubs.resolveCname.withArgs('example.com').resolves(['something.cdn.adobeaemcloud.com.']);
    dnsStubs.resolve4.withArgs('example.com').resolves([]);

    const result = await detectCdnForDomain('example.com');
    expect(result).to.equal('aem-cs-fastly');
  });

  it('returns aem-cs-fastly when A record matches known Fastly IP', async () => {
    dnsStubs.resolveCname.resolves([]);
    dnsStubs.resolve4.withArgs('www.example.com').resolves(['146.75.123.10']);

    const result = await detectCdnForDomain('example.com');
    expect(result).to.equal('aem-cs-fastly');
  });

  it('returns aem-cs-fastly for each of the four known Fastly IPs', async () => {
    const fastlyIPs = ['146.75.123.10', '151.101.195.10', '151.101.67.10', '151.101.3.10'];

    for (const ip of fastlyIPs) {
      dnsStubs.resolveCname.reset();
      dnsStubs.resolve4.reset();
      dnsStubs.resolveCname.resolves([]);
      dnsStubs.resolve4.withArgs('www.example.com').resolves([ip]);

      // eslint-disable-next-line no-await-in-loop
      const result = await detectCdnForDomain('example.com');
      expect(result).to.equal('aem-cs-fastly', `Expected aem-cs-fastly for IP ${ip}`);
    }
  });

  it('returns other when domain does not match Fastly CNAME or IPs', async () => {
    dnsStubs.resolveCname.resolves(['other-cdn.example.net.']);
    dnsStubs.resolve4.resolves(['1.2.3.4']);

    const result = await detectCdnForDomain('example.com');
    expect(result).to.equal('other');
  });

  it('returns null when DNS resolveCname throws for both hosts', async () => {
    dnsStubs.resolveCname.rejects(new Error('DNS error'));
    dnsStubs.resolve4.resolves([]);

    const result = await detectCdnForDomain('example.com');
    expect(result).to.be.null;
  });

  it('returns null when all DNS calls reject', async () => {
    dnsStubs.resolveCname.rejects(new Error('ENOTFOUND'));
    dnsStubs.resolve4.rejects(new Error('ENOTFOUND'));

    const result = await detectCdnForDomain('nonexistent.example.com');
    expect(result).to.be.null;
  });

  it('returns other when resolveCname returns empty and resolve4 returns non-matching IPs', async () => {
    dnsStubs.resolveCname.resolves([]);
    dnsStubs.resolve4.resolves(['1.2.3.4']);

    const result = await detectCdnForDomain('example.com');
    expect(result).to.equal('other');
  });

  it('returns aem-cs-fastly when www DNS fails but bare domain CNAME matches', async () => {
    dnsStubs.resolveCname.withArgs('www.example.com').rejects(new Error('ENOTFOUND'));
    dnsStubs.resolveCname.withArgs('example.com').resolves(['cdn.adobeaemcloud.com.']);
    dnsStubs.resolve4.resolves([]);

    const result = await detectCdnForDomain('example.com');
    expect(result).to.equal('aem-cs-fastly');
  });

  it('returns null when www returns other but bare DNS fails', async () => {
    dnsStubs.resolveCname.withArgs('www.example.com').resolves(['other-cdn.example.net.']);
    dnsStubs.resolve4.withArgs('www.example.com').resolves(['1.2.3.4']);
    dnsStubs.resolveCname.withArgs('example.com').rejects(new Error('ENOTFOUND'));

    const result = await detectCdnForDomain('example.com');
    expect(result).to.be.null;
  });

  it('returns null when www DNS fails and bare returns other', async () => {
    dnsStubs.resolveCname.withArgs('www.example.com').rejects(new Error('ENOTFOUND'));
    dnsStubs.resolveCname.withArgs('example.com').resolves(['other-cdn.example.net.']);
    dnsStubs.resolve4.withArgs('example.com').resolves(['1.2.3.4']);

    const result = await detectCdnForDomain('example.com');
    expect(result).to.be.null;
  });

  it('returns null when CNAME resolves but resolve4 fails', async () => {
    dnsStubs.resolveCname.resolves(['other-cdn.example.net.']);
    dnsStubs.resolve4.rejects(new Error('SERVFAIL'));

    const result = await detectCdnForDomain('example.com');
    expect(result).to.be.null;
  });

  it('returns null when an unexpected error occurs in checkHost', async () => {
    dnsStubs.resolveCname.resolves(null);
    dnsStubs.resolve4.resolves([]);

    const result = await detectCdnForDomain('example.com');
    expect(result).to.be.null;
  });
});
