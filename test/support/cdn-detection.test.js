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

function dnsError(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

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
    dnsStubs.resolve4.withArgs('www.example.com').resolves(['151.101.131.10']);

    const result = await detectCdnForDomain('example.com');
    expect(result).to.equal('aem-cs-fastly');
  });

  it('returns aem-cs-fastly when CNAME matches adobe-aem.map.fastly.net', async () => {
    dnsStubs.resolveCname.withArgs('www.example.com').resolves(['adobe-aem.map.fastly.net']);
    dnsStubs.resolve4.resolves([]);

    const result = await detectCdnForDomain('example.com');
    expect(result).to.equal('aem-cs-fastly');
  });

  it('returns aem-cs-fastly for each of the known Fastly IPs', async () => {
    const fastlyIPs = ['151.101.195.10', '151.101.67.10', '151.101.3.10', '151.101.131.10'];

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

  it('returns other when no CNAME records exist (ENODATA) but A records have non-matching IPs', async () => {
    dnsStubs.resolveCname.rejects(dnsError('ENODATA'));
    dnsStubs.resolve4.resolves(['1.2.3.4']);

    const result = await detectCdnForDomain('example.com');
    expect(result).to.equal('other');
  });

  it('returns aem-cs-fastly when no CNAME records exist (ENODATA) but A records match Fastly IP', async () => {
    dnsStubs.resolveCname.rejects(dnsError('ENODATA'));
    dnsStubs.resolve4.resolves(['151.101.195.10']);

    const result = await detectCdnForDomain('example.com');
    expect(result).to.equal('aem-cs-fastly');
  });

  it('returns other when domain does not exist (ENOTFOUND) for all lookups', async () => {
    dnsStubs.resolveCname.rejects(dnsError('ENOTFOUND'));
    dnsStubs.resolve4.rejects(dnsError('ENOTFOUND'));

    const result = await detectCdnForDomain('nonexistent.example.com');
    expect(result).to.equal('other');
  });

  it('returns null when DNS server fails (SERVFAIL) for resolveCname on both hosts', async () => {
    dnsStubs.resolveCname.rejects(dnsError('SERVFAIL'));
    dnsStubs.resolve4.resolves([]);

    const result = await detectCdnForDomain('example.com');
    expect(result).to.be.null;
  });

  it('returns null when all DNS calls fail with SERVFAIL', async () => {
    dnsStubs.resolveCname.rejects(dnsError('SERVFAIL'));
    dnsStubs.resolve4.rejects(dnsError('SERVFAIL'));

    const result = await detectCdnForDomain('example.com');
    expect(result).to.be.null;
  });

  it('returns other when resolveCname returns empty and resolve4 returns non-matching IPs', async () => {
    dnsStubs.resolveCname.resolves([]);
    dnsStubs.resolve4.resolves(['1.2.3.4']);

    const result = await detectCdnForDomain('example.com');
    expect(result).to.equal('other');
  });

  it('returns aem-cs-fastly when www DNS fails but bare domain CNAME matches', async () => {
    dnsStubs.resolveCname.withArgs('www.example.com').rejects(dnsError('SERVFAIL'));
    dnsStubs.resolveCname.withArgs('example.com').resolves(['cdn.adobeaemcloud.com.']);
    dnsStubs.resolve4.resolves([]);

    const result = await detectCdnForDomain('example.com');
    expect(result).to.equal('aem-cs-fastly');
  });

  it('returns null when www returns other but bare DNS fails', async () => {
    dnsStubs.resolveCname.withArgs('www.example.com').resolves(['other-cdn.example.net.']);
    dnsStubs.resolve4.withArgs('www.example.com').resolves(['1.2.3.4']);
    dnsStubs.resolveCname.withArgs('example.com').rejects(dnsError('SERVFAIL'));

    const result = await detectCdnForDomain('example.com');
    expect(result).to.be.null;
  });

  it('returns null when www DNS fails and bare returns other', async () => {
    dnsStubs.resolveCname.withArgs('www.example.com').rejects(dnsError('SERVFAIL'));
    dnsStubs.resolveCname.withArgs('example.com').resolves(['other-cdn.example.net.']);
    dnsStubs.resolve4.withArgs('example.com').resolves(['1.2.3.4']);

    const result = await detectCdnForDomain('example.com');
    expect(result).to.be.null;
  });

  it('returns null when CNAME resolves non-matching but resolve4 fails with SERVFAIL', async () => {
    dnsStubs.resolveCname.resolves(['other-cdn.example.net.']);
    dnsStubs.resolve4.rejects(dnsError('SERVFAIL'));

    const result = await detectCdnForDomain('example.com');
    expect(result).to.be.null;
  });

  it('returns null when an unexpected error occurs in checkHost', async () => {
    dnsStubs.resolveCname.resolves(null);
    dnsStubs.resolve4.resolves([]);

    const result = await detectCdnForDomain('example.com');
    expect(result).to.be.null;
  });

  it('returns null when CNAME has ENODATA but resolve4 fails with SERVFAIL', async () => {
    dnsStubs.resolveCname.rejects(dnsError('ENODATA'));
    dnsStubs.resolve4.rejects(dnsError('SERVFAIL'));

    const result = await detectCdnForDomain('example.com');
    expect(result).to.be.null;
  });

  describe('logging', () => {
    let log;

    beforeEach(() => {
      log = { info: sinon.stub() };
    });

    it('logs CNAMEs and IPs when detection returns other', async () => {
      dnsStubs.resolveCname.resolves(['other-cdn.example.net.']);
      dnsStubs.resolve4.resolves(['1.2.3.4']);

      const result = await detectCdnForDomain('example.com', log);
      expect(result).to.equal('other');
      expect(log.info).to.have.been.calledWith('[cdn-detection] Detecting CDN for domain example.com');
      expect(log.info).to.have.been.calledWith(sinon.match('CNAMEs for www.example.com'));
      expect(log.info).to.have.been.calledWith(sinon.match('IPs for www.example.com'));
    });

    it('logs CNAME match when detection returns aem-cs-fastly', async () => {
      dnsStubs.resolveCname.withArgs('www.example.com').resolves(['cdn.adobeaemcloud.com.']);

      const result = await detectCdnForDomain('example.com', log);
      expect(result).to.equal('aem-cs-fastly');
      expect(log.info).to.have.been.calledWith(sinon.match('CNAMEs for www.example.com'));
    });

    it('logs DNS failure for CNAME and A record', async () => {
      dnsStubs.resolveCname.rejects(dnsError('SERVFAIL'));
      dnsStubs.resolve4.rejects(dnsError('SERVFAIL'));

      const result = await detectCdnForDomain('example.com', log);
      expect(result).to.be.null;
      expect(log.info).to.have.been.calledWith(sinon.match('DNS lookup failed for www.example.com (CNAME)'));
    });

    it('logs CNAME success then A record failure', async () => {
      dnsStubs.resolveCname.resolves(['other-cdn.example.net.']);
      dnsStubs.resolve4.rejects(dnsError('SERVFAIL'));

      const result = await detectCdnForDomain('example.com', log);
      expect(result).to.be.null;
      expect(log.info).to.have.been.calledWith(sinon.match('CNAMEs for www.example.com'));
      expect(log.info).to.have.been.calledWith(sinon.match('DNS lookup failed for www.example.com (A record)'));
    });

    it('logs (none) when CNAMEs and IPs resolve to empty arrays', async () => {
      dnsStubs.resolveCname.resolves([]);
      dnsStubs.resolve4.resolves([]);

      const result = await detectCdnForDomain('example.com', log);
      expect(result).to.equal('other');
      expect(log.info).to.have.been.calledWith('[cdn-detection] CNAMEs for www.example.com: (none)');
      expect(log.info).to.have.been.calledWith('[cdn-detection] IPs for www.example.com: (none)');
    });
  });
});
