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
import { expect, use } from 'chai';
import sinonChai from 'sinon-chai';
import sinon from 'sinon';
import esmock from 'esmock';

use(sinonChai);

function dnsError(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

describe('cdn-detection', () => {
  let sandbox;
  let detectCdnForDomain;
  let dnsStubs;
  let fetchStub;

  beforeEach(async () => {
    sandbox = sinon.createSandbox();

    dnsStubs = {
      resolveCname: sandbox.stub(),
      resolve4: sandbox.stub(),
      resolve6: sandbox.stub().resolves([]),
      reverse: sandbox.stub().rejects(dnsError('ENOTFOUND')),
    };

    // Default Phase 2 to a no-op: every HTTP probe (HEAD/GET, DoH, ipinfo) rejects,
    // so the detector falls back to DNS-only behaviour and existing Phase 1 tests
    // remain authoritative.
    fetchStub = sandbox.stub().rejects(new Error('test: network disabled'));

    ({ detectCdnForDomain } = await esmock('../../src/support/cdn-detection.js', {
      dns: { promises: dnsStubs },
      '@adobe/spacecat-shared-utils': {
        tracingFetch: fetchStub,
        SPACECAT_USER_AGENT: 'spacecat-cdn-detection-test',
      },
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
    const fastlyIPs = [
      '151.101.195.10',
      '151.101.67.10',
      '151.101.3.10',
      '151.101.131.10',
    ];

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

  it('returns aem-cs-fastly when CNAME exactly equals pattern (no trailing dot)', async () => {
    dnsStubs.resolveCname.withArgs('www.example.com').resolves(['cdn.adobeaemcloud.com']);
    dnsStubs.resolve4.resolves([]);

    const result = await detectCdnForDomain('example.com');
    expect(result).to.equal('aem-cs-fastly');
  });

  it('does NOT match an attacker-suffixed CNAME (suffix match, not substring)', async () => {
    // Demonstrates the tightening from includes() to endsWith(): an attacker
    // cannot add additional labels after a known Fastly target and still be
    // classified as AEM CS Fastly.
    dnsStubs.resolveCname.resolves(['evil.cdn.adobeaemcloud.com.attacker.com']);
    dnsStubs.resolve4.resolves(['1.2.3.4']);

    const result = await detectCdnForDomain('example.com');
    expect(result).to.equal('other');
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
    dnsStubs.resolve6.rejects(dnsError('ENOTFOUND'));

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
    dnsStubs.resolve6.rejects(dnsError('SERVFAIL'));

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

  describe('commerce-fastly', () => {
    const commerceIPs = [
      '151.101.1.124',
      '151.101.65.124',
      '151.101.129.124',
      '151.101.193.124',
    ];
    const commerceIPv6 = [
      '2a04:4e42:200::380',
      '2a04:4e42:400::380',
      '2a04:4e42:600::380',
      '2a04:4e42::380',
    ];

    it('returns commerce-fastly when www CNAME matches prod.magentocloud.map.fastly.net', async () => {
      dnsStubs.resolveCname.withArgs('www.example.com').resolves(['prod.magentocloud.map.fastly.net.']);
      dnsStubs.resolve4.resolves([]);

      const result = await detectCdnForDomain('example.com');
      expect(result).to.equal('commerce-fastly');
    });

    it('returns commerce-fastly when www CNAME matches basic.magentocloud.map.fastly.net', async () => {
      dnsStubs.resolveCname.withArgs('www.example.com').resolves(['basic.magentocloud.map.fastly.net.']);
      dnsStubs.resolve4.resolves([]);

      const result = await detectCdnForDomain('example.com');
      expect(result).to.equal('commerce-fastly');
    });

    it('returns commerce-fastly when bare CNAME matches commerce pattern', async () => {
      dnsStubs.resolveCname.withArgs('www.example.com').resolves([]);
      dnsStubs.resolve4.withArgs('www.example.com').resolves([]);
      dnsStubs.resolveCname.withArgs('example.com').resolves(['prod.magentocloud.map.fastly.net']);
      dnsStubs.resolve4.withArgs('example.com').resolves([]);

      const result = await detectCdnForDomain('example.com');
      expect(result).to.equal('commerce-fastly');
    });

    it('returns commerce-fastly when CNAME is a chained subdomain of the commerce target', async () => {
      dnsStubs.resolveCname.withArgs('www.example.com').resolves(['foo.prod.magentocloud.map.fastly.net.']);
      dnsStubs.resolve4.resolves([]);

      const result = await detectCdnForDomain('example.com');
      expect(result).to.equal('commerce-fastly');
    });

    it('returns commerce-fastly for each of the 4 known Commerce A-record IPs', async () => {
      for (const ip of commerceIPs) {
        dnsStubs.resolveCname.reset();
        dnsStubs.resolve4.reset();
        dnsStubs.resolve6.reset();
        dnsStubs.resolveCname.resolves([]);
        dnsStubs.resolve4.withArgs('www.example.com').resolves([ip]);
        dnsStubs.resolve6.resolves([]);

        // eslint-disable-next-line no-await-in-loop
        const result = await detectCdnForDomain('example.com');
        expect(result).to.equal('commerce-fastly', `Expected commerce-fastly for IP ${ip}`);
      }
    });

    it('returns commerce-fastly for each of the 4 known Commerce AAAA-record IPs', async () => {
      for (const ipv6 of commerceIPv6) {
        dnsStubs.resolveCname.reset();
        dnsStubs.resolve4.reset();
        dnsStubs.resolve6.reset();
        dnsStubs.resolveCname.resolves([]);
        dnsStubs.resolve4.resolves([]);
        dnsStubs.resolve6.withArgs('www.example.com').resolves([ipv6]);

        // eslint-disable-next-line no-await-in-loop
        const result = await detectCdnForDomain('example.com');
        expect(result).to.equal('commerce-fastly', `Expected commerce-fastly for IPv6 ${ipv6}`);
      }
    });

    it('returns commerce-fastly when only AAAA matches (CNAME and A return ENODATA)', async () => {
      dnsStubs.resolveCname.rejects(dnsError('ENODATA'));
      dnsStubs.resolve4.rejects(dnsError('ENODATA'));
      dnsStubs.resolve6.withArgs('www.example.com').resolves(['2a04:4e42::380']);

      const result = await detectCdnForDomain('example.com');
      expect(result).to.equal('commerce-fastly');
    });

    it('returns other when CNAME/A/AAAA all resolve but none match', async () => {
      dnsStubs.resolveCname.resolves(['other-cdn.example.net.']);
      dnsStubs.resolve4.resolves(['1.2.3.4']);
      dnsStubs.resolve6.resolves(['2001:db8::1']);

      const result = await detectCdnForDomain('example.com');
      expect(result).to.equal('other');
    });

    it('returns null when AAAA lookup fails with SERVFAIL on www and bare returns other', async () => {
      dnsStubs.resolveCname.withArgs('www.example.com').resolves([]);
      dnsStubs.resolve4.withArgs('www.example.com').resolves([]);
      dnsStubs.resolve6.withArgs('www.example.com').rejects(dnsError('SERVFAIL'));
      dnsStubs.resolveCname.withArgs('example.com').resolves(['other-cdn.example.net.']);
      dnsStubs.resolve4.withArgs('example.com').resolves(['1.2.3.4']);
      dnsStubs.resolve6.withArgs('example.com').resolves([]);

      const result = await detectCdnForDomain('example.com');
      expect(result).to.be.null;
    });

    it('AEM CS Fastly wins when both CNAME signature sets theoretically match at the CNAME layer', async () => {
      // Contrived: a CNAME answer containing both an AEM CS target and a
      // Commerce target. Per the detection contract, AEM CS is evaluated
      // first within each layer as a deterministic tie-breaker.
      dnsStubs.resolveCname.withArgs('www.example.com').resolves([
        'cdn.adobeaemcloud.com',
        'prod.magentocloud.map.fastly.net',
      ]);
      dnsStubs.resolve4.resolves([]);

      const result = await detectCdnForDomain('example.com');
      expect(result).to.equal('aem-cs-fastly');
    });

    it('AEM CS Fastly wins when both A-record signature sets theoretically match at the A layer', async () => {
      // Contrived: an A answer containing both an AEM CS IP and a Commerce IP.
      dnsStubs.resolveCname.resolves([]);
      dnsStubs.resolve4.withArgs('www.example.com').resolves([
        '151.101.195.10',
        '151.101.1.124',
      ]);

      const result = await detectCdnForDomain('example.com');
      expect(result).to.equal('aem-cs-fastly');
    });
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
      expect(log.info).to.have.been.calledWith(sinon.match('Detected CNAMES for domain www.example.com'));
      expect(log.info).to.have.been.calledWith(sinon.match('Detected IPs for domain www.example.com'));
    });

    it('logs CNAME match when detection returns aem-cs-fastly', async () => {
      dnsStubs.resolveCname.withArgs('www.example.com').resolves(['cdn.adobeaemcloud.com.']);

      const result = await detectCdnForDomain('example.com', log);
      expect(result).to.equal('aem-cs-fastly');
      expect(log.info).to.have.been.calledWith(sinon.match('Detected CNAMES for domain www.example.com'));
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
      expect(log.info).to.have.been.calledWith(sinon.match('Detected CNAMES for domain www.example.com'));
      expect(log.info).to.have.been.calledWith(sinon.match('DNS lookup failed for www.example.com (A record)'));
    });

    it('logs AAAA failure when resolve6 fails with SERVFAIL', async () => {
      dnsStubs.resolveCname.resolves(['other-cdn.example.net.']);
      dnsStubs.resolve4.resolves(['1.2.3.4']);
      dnsStubs.resolve6.rejects(dnsError('SERVFAIL'));

      const result = await detectCdnForDomain('example.com', log);
      expect(result).to.be.null;
      expect(log.info).to.have.been.calledWith(sinon.match('DNS lookup failed for www.example.com (AAAA record)'));
    });

    it('logs IPv6 answer when AAAA records are present', async () => {
      dnsStubs.resolveCname.resolves([]);
      dnsStubs.resolve4.resolves([]);
      dnsStubs.resolve6.withArgs('www.example.com').resolves(['2a04:4e42::380']);

      const result = await detectCdnForDomain('example.com', log);
      expect(result).to.equal('commerce-fastly');
      expect(log.info).to.have.been.calledWith(sinon.match('Detected IPv6 for domain www.example.com'));
    });

    it('logs empty CNAME and IP arrays like edge-routing-utils (template interpolation)', async () => {
      dnsStubs.resolveCname.resolves([]);
      dnsStubs.resolve4.resolves([]);

      const result = await detectCdnForDomain('example.com', log);
      expect(result).to.equal('other');
      expect(log.info).to.have.been.calledWith('[cdn-detection] Detected CNAMES for domain www.example.com: ');
      expect(log.info).to.have.been.calledWith('[cdn-detection] Detected IPs for domain www.example.com: ');
    });
  });

  // -----------------------------------------------------------------------
  // Phase 2 — generic multi-signal CDN fingerprinting (ported from
  // spacecat-audit-worker). Phase 1 is forced to 'other' (clean DNS, no
  // Adobe match) so Phase 2 owns the result, then we assert the adapter
  // (LABEL_TO_LLMO_TOKEN) translates each detector label into the correct
  // LLMO byocdn-X token.
  // -----------------------------------------------------------------------
  describe('phase 2 — generic CDN fingerprinting', () => {
    function mockHeaderResponse(headersObj = {}) {
      const lower = new Map(
        Object.entries(headersObj).map(([k, v]) => [k.toLowerCase(), v]),
      );
      return {
        ok: true,
        headers: { forEach: (cb) => lower.forEach((v, k) => cb(v, k)) },
        body: { cancel: () => {} },
        json: async () => ({}),
      };
    }

    // Force Phase 1 to a clean 'other' so Phase 2 always runs.
    beforeEach(() => {
      dnsStubs.resolveCname.resolves(['no-match.example.net.']);
      dnsStubs.resolve4.resolves(['1.2.3.4']);
      dnsStubs.resolve6.resolves([]);
    });

    function probeReturns(headers) {
      fetchStub.callsFake((url) => {
        if (url.startsWith('https://example.com') || url.startsWith('https://www.example.com')) {
          return Promise.resolve(mockHeaderResponse(headers));
        }
        return Promise.reject(new Error('blocked'));
      });
    }

    const headerCases = [
      { name: 'Cloudflare (cf-ray)', headers: { 'cf-ray': 'abc' }, token: 'byocdn-cloudflare' },
      { name: 'Akamai (x-akamai-transformed)', headers: { 'x-akamai-transformed': '9' }, token: 'byocdn-akamai' },
      { name: 'Fastly BYOCDN (x-fastly-request-id)', headers: { 'x-fastly-request-id': 'abc' }, token: 'byocdn-fastly' },
      { name: 'CloudFront (x-amz-cf-id)', headers: { 'x-amz-cf-id': 'abc' }, token: 'byocdn-cloudfront' },
      { name: 'Imperva (x-iinfo)', headers: { 'x-iinfo': 'a' }, token: 'byocdn-imperva' },
      { name: 'Azure combined (x-azure-ref)', headers: { 'x-azure-ref': 'a' }, token: 'byocdn-azure' },
      { name: 'Azure CDN (x-ec-debug)', headers: { 'x-ec-debug': 'a' }, token: 'byocdn-azure' },
      { name: 'Azure Front Door (x-fd-healthprobe)', headers: { 'x-fd-healthprobe': '1' }, token: 'byocdn-frontdoor' },
      { name: 'Google Cloud CDN (x-goog-*)', headers: { 'x-goog-foo': '1' }, token: 'byocdn-google' },
      { name: 'Vercel (x-vercel-id)', headers: { 'x-vercel-id': '1' }, token: 'byocdn-vercel' },
      { name: 'Netlify (x-nf-request-id)', headers: { 'x-nf-request-id': '1' }, token: 'byocdn-netlify' },
      { name: 'KeyCDN (x-edge-location)', headers: { 'x-edge-location': '1' }, token: 'byocdn-keycdn' },
      { name: 'Limelight (x-llid)', headers: { 'x-llid': '1' }, token: 'byocdn-limelight' },
      { name: 'CDNetworks (x-cdn-request-id)', headers: { 'x-cdn-request-id': '1' }, token: 'byocdn-cdnetworks' },
      { name: 'Bunny CDN (x-bunny-*)', headers: { 'x-bunny-foo': '1' }, token: 'byocdn-bunny' },
      { name: 'StackPath (server: NetDNA)', headers: { server: 'NetDNA-cache' }, token: 'byocdn-stackpath' },
      { name: 'Sucuri (x-sucuri-id)', headers: { 'x-sucuri-id': '1' }, token: 'byocdn-sucuri' },
      { name: 'Alibaba via keyword (x-cdn: alicdn)', headers: { 'x-cdn': 'alicdn' }, token: 'byocdn-cloudflare' /* sanity placeholder; replaced below */ },
    ];

    // Drop the placeholder; Alibaba isn't matched via headers, only via DNS/ASN.
    headerCases.pop();

    for (const { name, headers, token } of headerCases) {
      // eslint-disable-next-line no-loop-func
      it(`maps ${name} header to ${token}`, async () => {
        probeReturns(headers);
        const result = await detectCdnForDomain('example.com');
        expect(result).to.equal(token);
      });
    }

    it('returns other when HTTP probe fails and DNS/ASN fallback finds nothing', async () => {
      // fetchStub default rejects everything; DNS fallback also misses.
      const result = await detectCdnForDomain('example.com');
      expect(result).to.equal('other');
    });

    it('returns null when Phase 1 DNS fails and Phase 2 cannot detect either', async () => {
      dnsStubs.resolveCname.rejects(dnsError('SERVFAIL'));
      dnsStubs.resolve4.rejects(dnsError('SERVFAIL'));
      dnsStubs.resolve6.rejects(dnsError('SERVFAIL'));
      const result = await detectCdnForDomain('example.com');
      expect(result).to.be.null;
    });

    it('detects via DNS fallback CNAME chain (Cloudflare suffix)', async () => {
      dnsStubs.resolveCname.resolves(['something.cloudflare.com.']);
      const result = await detectCdnForDomain('example.com');
      expect(result).to.equal('byocdn-cloudflare');
    });

    it('detects via DNS fallback CNAME chain (Akamai suffix)', async () => {
      dnsStubs.resolveCname.resolves(['e1234.b.akamaiedge.net.']);
      const result = await detectCdnForDomain('example.com');
      expect(result).to.equal('byocdn-akamai');
    });

    it('detects via ASN when CNAME and headers miss (AS13335 → Cloudflare)', async () => {
      fetchStub.callsFake((url) => {
        if (url.startsWith('https://ipinfo.io/')) {
          return Promise.resolve({
            ok: true,
            headers: { forEach: () => {} },
            body: { cancel: () => {} },
            json: async () => ({ org: 'AS13335 Cloudflare, Inc.' }),
          });
        }
        return Promise.reject(new Error('blocked'));
      });
      const result = await detectCdnForDomain('example.com');
      expect(result).to.equal('byocdn-cloudflare');
    });

    it('detects via ASN (AS54113 → Fastly BYOCDN)', async () => {
      fetchStub.callsFake((url) => {
        if (url.startsWith('https://ipinfo.io/')) {
          return Promise.resolve({
            ok: true,
            headers: { forEach: () => {} },
            body: { cancel: () => {} },
            json: async () => ({ org: 'AS54113 Fastly, Inc.' }),
          });
        }
        return Promise.reject(new Error('blocked'));
      });
      const result = await detectCdnForDomain('example.com');
      expect(result).to.equal('byocdn-fastly');
    });

    it('detects via PTR keyword (Akamai PTR record)', async () => {
      dnsStubs.reverse.resolves(['a23-45-67-89.deploy.static.akamaitechnologies.com']);
      const result = await detectCdnForDomain('example.com');
      expect(result).to.equal('byocdn-akamai');
    });

    it('detects via DoH CNAME (system DNS misses, DoH carries it)', async () => {
      // System resolver returns no signature; DoH returns a Cloudflare CNAME.
      dnsStubs.resolveCname.resolves([]);
      fetchStub.callsFake((url) => {
        if (url.startsWith('https://dns.google/resolve') && url.includes('type=5')) {
          return Promise.resolve({
            ok: true,
            headers: { forEach: () => {} },
            body: { cancel: () => {} },
            json: async () => ({ Answer: [{ type: 5, data: 'edge.cloudflare.com.' }] }),
          });
        }
        return Promise.reject(new Error('blocked'));
      });
      const result = await detectCdnForDomain('example.com');
      expect(result).to.equal('byocdn-cloudflare');
    });

    it('Phase 1 wins over Phase 2: AEM CS Fastly DNS match short-circuits HTTP probe', async () => {
      dnsStubs.resolveCname.withArgs('www.example.com').resolves(['cdn.adobeaemcloud.com.']);
      probeReturns({ 'cf-ray': 'should-be-skipped' });

      const result = await detectCdnForDomain('example.com');
      expect(result).to.equal('aem-cs-fastly');

      const probedSite = fetchStub.getCalls().some((c) => {
        const url = c.args[0];
        return typeof url === 'string'
          && url.includes('example.com')
          && !url.startsWith('https://dns.google')
          && !url.startsWith('https://ipinfo.io');
      });
      expect(probedSite, 'Phase 2 HTTP probe should not run when Phase 1 hits').to.be.false;
    });

    it('accepts a full URL as input (preserves backwards-compat with hostname-only)', async () => {
      probeReturns({ 'cf-ray': 'abc' });
      const result = await detectCdnForDomain('https://example.com/some/path');
      expect(result).to.equal('byocdn-cloudflare');
    });

    it('returns null for empty input', async () => {
      const result = await detectCdnForDomain('');
      expect(result).to.be.null;
    });

    it('returns null for whitespace-only input', async () => {
      const result = await detectCdnForDomain('   ');
      expect(result).to.be.null;
    });

    it('returns null for malformed input that cannot be parsed as a URL', async () => {
      // URL with embedded space cannot be parsed.
      const result = await detectCdnForDomain('not a url');
      expect(result).to.be.null;
    });

    it('falls back to GET when HEAD fails, then detects via headers', async () => {
      let headCalls = 0;
      fetchStub.callsFake((url, opts) => {
        if (url.startsWith('https://example.com') || url.startsWith('https://www.example.com')) {
          if (opts?.method === 'HEAD') {
            headCalls += 1;
            return Promise.reject(new Error('HEAD blocked'));
          }
          return Promise.resolve(mockHeaderResponse({ 'cf-ray': 'abc' }));
        }
        return Promise.reject(new Error('blocked'));
      });
      const result = await detectCdnForDomain('example.com');
      expect(result).to.equal('byocdn-cloudflare');
      expect(headCalls).to.be.greaterThan(0);
    });
  });
});
