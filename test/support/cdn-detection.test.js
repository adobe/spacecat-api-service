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
import nock from 'nock';
import { tracingFetch as realTracingFetch } from '@adobe/spacecat-shared-utils';

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
  let aemcsWafSimpleProxyFetchStub;

  beforeEach(async () => {
    sandbox = sinon.createSandbox();

    dnsStubs = {
      resolveCname: sandbox.stub(),
      resolve4: sandbox.stub(),
      resolve6: sandbox.stub().resolves([]),
      reverse: sandbox.stub().rejects(dnsError('ENOTFOUND')),
    };

    // Phase 1.5 probes use tracingFetch with cache: 'no-store'. Default to reject
    // so Phase 1.5 always fails unless a test overrides it.
    aemcsWafSimpleProxyFetchStub = sandbox.stub().rejects(new Error('test: network disabled'));

    // Default Phase 2 to a no-op: every HTTP probe (HEAD/GET) rejects,
    // so the detector falls back to DNS-only behaviour and existing Phase 1 tests
    // remain authoritative.
    fetchStub = sandbox.stub().rejects(new Error('test: network disabled'));

    ({ detectCdnForDomain } = await esmock('../../src/support/cdn-detection.js', {
      dns: { promises: dnsStubs },
      '@adobe/spacecat-shared-utils': {
        tracingFetch: (...args) => {
          const headers = args[1]?.headers || {};
          if (headers['x-aem-debug'] === 'edge=true') {
            return aemcsWafSimpleProxyFetchStub(...args);
          }
          return fetchStub(...args);
        },
        SPACECAT_USER_AGENT: 'spacecat-cdn-detection-test',
      },
    }));
  });

  afterEach(() => {
    nock.cleanAll();
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
    expect(result).to.equal('byocdn-other');
  });

  it('returns other when domain does not match Fastly CNAME or IPs', async () => {
    dnsStubs.resolveCname.resolves(['other-cdn.example.net.']);
    dnsStubs.resolve4.resolves(['1.2.3.4']);

    const result = await detectCdnForDomain('example.com');
    expect(result).to.equal('byocdn-other');
  });

  it('returns other when no CNAME records exist (ENODATA) but A records have non-matching IPs', async () => {
    dnsStubs.resolveCname.rejects(dnsError('ENODATA'));
    dnsStubs.resolve4.resolves(['1.2.3.4']);

    const result = await detectCdnForDomain('example.com');
    expect(result).to.equal('byocdn-other');
  });

  it('returns aem-cs-fastly when no CNAME records exist (ENODATA) but A records match Fastly IP', async () => {
    dnsStubs.resolveCname.rejects(dnsError('ENODATA'));
    dnsStubs.resolve4.resolves(['151.101.195.10']);

    const result = await detectCdnForDomain('example.com');
    expect(result).to.equal('aem-cs-fastly');
  });

  it('returns null when domain does not exist (ENOTFOUND) — Phase 2 has no signals to work with', async () => {
    // ENOTFOUND on every Phase 1 lookup → Phase 1 would return byocdn-other
    // (clean miss), but Phase 2 also has no DNS chain or IP to inspect.
    // With probeSucceeded tracking, the detector now reports null instead
    // of misleading byocdn-other.
    dnsStubs.resolveCname.rejects(dnsError('ENOTFOUND'));
    dnsStubs.resolve4.rejects(dnsError('ENOTFOUND'));
    dnsStubs.resolve6.rejects(dnsError('ENOTFOUND'));

    const result = await detectCdnForDomain('nonexistent.example.com');
    expect(result).to.be.null;
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
    expect(result).to.equal('byocdn-other');
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

  it('returns byocdn-other when www DNS fails but bare domain resolves to a non-Adobe CDN', async () => {
    // www DNS fails but bare domain resolves cleanly — && null guard lets bare
    // result (byocdn-other) surface, and Phase 2 CNAME chain confirms the CDN.
    dnsStubs.resolveCname.withArgs('www.example.com').rejects(dnsError('SERVFAIL'));
    dnsStubs.resolveCname.withArgs('example.com').resolves(['other-cdn.example.net.']);
    dnsStubs.resolve4.withArgs('example.com').resolves(['1.2.3.4']);

    const result = await detectCdnForDomain('example.com');
    expect(result).to.equal('byocdn-other');
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
      expect(result).to.equal('byocdn-other');
    });

    it('returns byocdn-other when AAAA fails on www but bare domain resolves to a non-Adobe CDN', async () => {
      // www DNS fails on AAAA but bare domain resolves cleanly — the &&-only null
      // guard lets detectAdobeManagedCdn return 'byocdn-other' so Phase 2 can
      // confirm the CDN from the bare-domain CNAME chain.
      dnsStubs.resolveCname.withArgs('www.example.com').resolves([]);
      dnsStubs.resolve4.withArgs('www.example.com').resolves([]);
      dnsStubs.resolve6.withArgs('www.example.com').rejects(dnsError('SERVFAIL'));
      dnsStubs.resolveCname.withArgs('example.com').resolves(['other-cdn.example.net.']);
      dnsStubs.resolve4.withArgs('example.com').resolves(['1.2.3.4']);
      dnsStubs.resolve6.withArgs('example.com').resolves([]);

      const result = await detectCdnForDomain('example.com');
      expect(result).to.equal('byocdn-other');
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
      expect(result).to.equal('byocdn-other');
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

      // Phase 1 is a clean byocdn-other but Phase 2 has no IP either, so the
      // new probeSucceeded gate downgrades to null. The log assertions still
      // cover the template-interpolation behaviour we care about.
      const result = await detectCdnForDomain('example.com', log);
      expect(result).to.be.null;
      expect(log.info).to.have.been.calledWith('[cdn-detection] Detected CNAMES for domain www.example.com: ');
      expect(log.info).to.have.been.calledWith('[cdn-detection] Detected IPs for domain www.example.com: ');
    });
  });

  // -----------------------------------------------------------------------
  // Phase 1.5 — Case 0: AEM CS WAF Simple Proxy.
  //
  // Phase 1 DNS resolves to non-Adobe IPs ('byocdn-other'). Phase 1.5 runs
  // AEMCS_WAF_SIMPLE_PROXY_PROBE_COUNT sequential HTTP probes and checks four signals:
  //   1. x-correlation-id echoed unchanged in all responses
  //   2. x-edgeoptimize-request-id present in all responses
  //   3. x-request-id unique across all probes (AEMCS_WAF_SIMPLE_PROXY_PROBE_COUNT — no caching)
  //   4. x-aem-debug response header contains host=<probed-domain>
  // -----------------------------------------------------------------------
  describe('phase 1.5 — aemcs waf simple proxy', () => {
    // Helper: build a mock HTTP response carrying all four Case 0 signals.
    // n is the call counter; unique per call so x-request-id is distinct.
    function aemcsWafSimpleProxyResponse(n, overrides = {}) {
      const base = {
        'x-correlation-id': 'adobeedgetest',
        'x-edgeoptimize-request-id': `ereq-${n}`,
        'x-request-id': `xreq-${n}`,
        'x-aem-debug': 'host=example.com cache=MISS',
      };
      const merged = { ...base, ...overrides };
      const lower = new Map(Object.entries(merged).map(([k, v]) => [k.toLowerCase(), v]));
      return {
        ok: true,
        headers: { forEach: (cb) => lower.forEach((v, k) => cb(v, k)) },
        body: { cancel: () => {} },
      };
    }

    // Force Phase 1 to byocdn-other (clean DNS, no Adobe match) so Phase 1.5 runs.
    beforeEach(() => {
      dnsStubs.resolveCname.resolves(['no-match.example.net.']);
      dnsStubs.resolve4.resolves(['1.2.3.4']);
      dnsStubs.resolve6.resolves([]);
    });

    it('returns aem-cs-fastly when all four signals are confirmed in all 3 probes', async () => {
      let n = 0;
      aemcsWafSimpleProxyFetchStub.callsFake((url) => {
        n += 1;
        // Signal 4 checks host=<probed-domain>; echo back hostname so www probe succeeds.
        const { hostname } = new URL(url);
        return Promise.resolve(aemcsWafSimpleProxyResponse(n, { 'x-aem-debug': `host=${hostname} cache=MISS` }));
      });

      const result = await detectCdnForDomain('example.com');
      expect(result).to.equal('aem-cs-fastly');
      // Phase 1.5 probes www.example.com 3 times; Phase 2 skipped
      expect(aemcsWafSimpleProxyFetchStub.callCount).to.equal(3);
      expect(aemcsWafSimpleProxyFetchStub.firstCall.args[1]).to.include({
        method: 'GET',
        redirect: 'manual',
        cache: 'no-store',
        timeout: 3000,
      });
    });

    it('falls through when signal 1 fails — x-correlation-id is not echoed unchanged', async () => {
      let n = 0;
      aemcsWafSimpleProxyFetchStub.callsFake((url) => {
        n += 1;
        const { hostname } = new URL(url);
        return Promise.resolve(aemcsWafSimpleProxyResponse(n, {
          'x-correlation-id': 'rewritten-by-proxy',
          'x-aem-debug': `host=${hostname} cache=MISS`,
        }));
      });

      const result = await detectCdnForDomain('example.com');
      expect(result).to.equal('byocdn-other');
    });

    it('falls through to Phase 2 when signal 2 is absent in all probes', async () => {
      // No request-id header in any response — Phase 1.5 cannot confirm signal 2.
      // Phase 2 then runs; DNS chain present → probeSucceeded=true → byocdn-other.
      let n = 0;
      aemcsWafSimpleProxyFetchStub.callsFake(() => {
        n += 1;
        const headers = new Map([
          ['x-correlation-id', 'adobeedgetest'],
          ['x-request-id', `xreq-${n}`],
          ['x-aem-debug', 'host=example.com'],
        ]);
        return Promise.resolve({
          ok: true,
          headers: { forEach: (cb) => headers.forEach((v, k) => cb(v, k)) },
          body: { cancel: () => {} },
        });
      });

      const result = await detectCdnForDomain('example.com');
      expect(result).to.equal('byocdn-other');
    });

    it('falls through when signal 3 fails — duplicate x-request-id across probes (caching detected)', async () => {
      // All probes return the same x-request-id — a caching WAF or CDN
      // serving the same cached response for every probe.
      let n = 0;
      aemcsWafSimpleProxyFetchStub.callsFake((url) => {
        n += 1;
        const { hostname } = new URL(url);
        return Promise.resolve(aemcsWafSimpleProxyResponse(n, {
          'x-request-id': 'xreq-cached',
          'x-aem-debug': `host=${hostname} cache=MISS`,
        }));
      });

      const result = await detectCdnForDomain('example.com');
      expect(result).to.equal('byocdn-other');
    });

    it('falls through when signal 3 fails — x-request-id absent from all responses', async () => {
      // x-request-id not present — Signal 3 requires it to be present and unique.
      let n = 0;
      aemcsWafSimpleProxyFetchStub.callsFake((url) => {
        n += 1;
        const { hostname } = new URL(url);
        return Promise.resolve(aemcsWafSimpleProxyResponse(n, {
          'x-request-id': '',
          'x-aem-debug': `host=${hostname} cache=MISS`,
        }));
      });

      const result = await detectCdnForDomain('example.com');
      expect(result).to.equal('byocdn-other');
    });

    it('accepts x-aem-debug host token after semicolon and spaces', async () => {
      let n = 0;
      aemcsWafSimpleProxyFetchStub.callsFake((url) => {
        n += 1;
        const { hostname } = new URL(url);
        return Promise.resolve(aemcsWafSimpleProxyResponse(n, {
          'x-aem-debug': `edge=true; cache=MISS ; host=${hostname}; x-forwarded-host=wrong-domain.com`,
        }));
      });

      const result = await detectCdnForDomain('example.com');
      expect(result).to.equal('aem-cs-fastly');
    });

    it('falls through when signal 4 fails — x-aem-debug host mismatch in all probes', async () => {
      let n = 0;
      aemcsWafSimpleProxyFetchStub.callsFake(() => {
        n += 1;
        return Promise.resolve(aemcsWafSimpleProxyResponse(n, { 'x-aem-debug': 'host=wrong-domain.com' }));
      });

      const result = await detectCdnForDomain('example.com');
      expect(result).to.equal('byocdn-other');
    });

    it('does not treat x-forwarded-host as the signal 4 host token', async () => {
      let n = 0;
      aemcsWafSimpleProxyFetchStub.callsFake((url) => {
        n += 1;
        const { hostname } = new URL(url);
        return Promise.resolve(aemcsWafSimpleProxyResponse(n, {
          'x-aem-debug': `x-forwarded-host=${hostname}; host=wrong-domain.com`,
        }));
      });

      const result = await detectCdnForDomain('example.com');
      expect(result).to.equal('byocdn-other');
    });

    it('falls through to Phase 2 when probe network fails entirely', async () => {
      // aemcsWafSimpleProxyFetchStub rejects by default (set in beforeEach) → Phase 1.5 cannot
      // make probes → falls through. Phase 2 DNS chain succeeds → byocdn-other.
      const result = await detectCdnForDomain('example.com');
      expect(result).to.equal('byocdn-other');
    });

    it('skips Phase 1.5 entirely when Phase 1 returns aem-cs-fastly', async () => {
      dnsStubs.resolveCname.withArgs('www.example.com').resolves(['cdn.adobeaemcloud.com.']);

      const result = await detectCdnForDomain('example.com');
      expect(result).to.equal('aem-cs-fastly');
      expect(aemcsWafSimpleProxyFetchStub.callCount).to.equal(0);
    });

    it('falls back to bare domain when www probe fails signal 4, bare probe succeeds', async () => {
      let n = 0;
      aemcsWafSimpleProxyFetchStub.callsFake((url) => {
        n += 1;
        const { hostname } = new URL(url);
        if (hostname === 'www.example.com') {
          // www probes: signal 4 fails (wrong host in x-aem-debug)
          return Promise.resolve(aemcsWafSimpleProxyResponse(n, { 'x-aem-debug': 'host=wrong-domain.com' }));
        }
        // Bare domain probes: all signals pass
        return Promise.resolve(aemcsWafSimpleProxyResponse(n));
      });

      const result = await detectCdnForDomain('example.com');
      expect(result).to.equal('aem-cs-fastly');
    });

    it('falls through when a probe fails mid-sequence', async () => {
      // Sequential probes: probe 1 succeeds, probe 2 rejects → Phase 1.5 returns null for
      // www and bare. Phase 2 DNS chain succeeds → byocdn-other.
      let n = 0;
      aemcsWafSimpleProxyFetchStub.callsFake(() => {
        n += 1;
        if (n % 2 === 0) {
          return Promise.reject(new Error('second probe fails'));
        }
        return Promise.resolve(aemcsWafSimpleProxyResponse(n));
      });

      const result = await detectCdnForDomain('example.com');
      expect(result).to.equal('byocdn-other');
    });

    it('logs signal-absent message when correlation echo is missing', async () => {
      const log = { info: sinon.stub(), warn: sinon.stub() };

      let n = 0;
      aemcsWafSimpleProxyFetchStub.callsFake((url) => {
        n += 1;
        const { hostname } = new URL(url);
        return Promise.resolve(aemcsWafSimpleProxyResponse(n, {
          'x-correlation-id': '',
          'x-aem-debug': `host=${hostname} cache=MISS`,
        }));
      });

      await detectCdnForDomain('example.com', log);
      expect(log.info).to.have.been.calledWith(
        '[cdn-detection] Phase 1.5: signal 1 absent — x-correlation-id not echoed',
        sinon.match.any,
      );
    });

    it('logs signal-absent message when AEM request-id header is missing', async () => {
      const log = { info: sinon.stub(), warn: sinon.stub() };

      let n = 0;
      aemcsWafSimpleProxyFetchStub.callsFake(() => {
        n += 1;
        const headers = new Map([
          ['x-correlation-id', 'adobeedgetest'],
          ['x-request-id', `xreq-${n}`],
          ['x-aem-debug', 'host=example.com'],
        ]);
        return Promise.resolve({
          ok: true,
          headers: { forEach: (cb) => headers.forEach((v, k) => cb(v, k)) },
          body: { cancel: () => {} },
        });
      });

      await detectCdnForDomain('example.com', log);
      expect(log.info).to.have.been.calledWith(
        '[cdn-detection] Phase 1.5: signal 2 absent — no edgeoptimize request-id header',
        sinon.match.any,
      );
    });

    it('logs Phase 1.5 success when all signals confirmed', async () => {
      const log = { info: sinon.stub(), warn: sinon.stub() };
      let n = 0;
      aemcsWafSimpleProxyFetchStub.callsFake((url) => {
        n += 1;
        const { hostname } = new URL(url);
        return Promise.resolve(aemcsWafSimpleProxyResponse(n, { 'x-aem-debug': `host=${hostname} cache=MISS` }));
      });

      const result = await detectCdnForDomain('example.com', log);
      expect(result).to.equal('aem-cs-fastly');
      expect(log.info).to.have.been.calledWith(
        '[cdn-detection] Phase 1.5: all signals confirmed — AEM CS Fastly WAF simple proxy',
        sinon.match.any,
      );
    });

    it('does not send Cache-Control or Pragma headers when using cache: no-store', async () => {
      let receivedHeaders;
      nock('https://case0-cache-option.test')
        .get('/')
        .reply(function handleRequest() {
          receivedHeaders = this.req.headers;
          return [
            200,
            'ok',
            {
              'x-correlation-id': receivedHeaders['x-correlation-id'] || '',
              'x-edgeoptimize-request-id': 'edge-request-id',
              'x-request-id': 'aem-request-id',
              'x-aem-debug': 'host=case0-cache-option.test',
            },
          ];
        });

      const response = await realTracingFetch('https://case0-cache-option.test/', {
        method: 'GET',
        redirect: 'manual',
        cache: 'no-store',
        timeout: 3000,
        headers: {
          'x-correlation-id': 'adobeedgetest',
          'x-aem-debug': 'edge=true',
          'User-Agent': 'AdobeEdgeOptimize-Test',
        },
      });
      await response.text();

      expect(receivedHeaders['x-correlation-id']).to.equal('adobeedgetest');
      expect(receivedHeaders['x-aem-debug']).to.equal('edge=true');
      expect(receivedHeaders['user-agent']).to.equal('AdobeEdgeOptimize-Test');
      expect(receivedHeaders).to.not.have.property('cache-control');
      expect(receivedHeaders).to.not.have.property('pragma');
    });
  });

  // -----------------------------------------------------------------------
  // Phase 2 — generic multi-signal CDN fingerprinting (ported from
  // spacecat-audit-worker). Phase 1 is forced to byocdn-other (clean DNS,
  // no Adobe match) so Phase 2 owns the result, then we assert the adapter
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

    // Force Phase 1 to a clean byocdn-other so Phase 2 always runs.
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

    // Token expectations mirror LABEL_TO_LLMO_TOKEN in cdn-detection.js.
    // Every CDN whose tenancy can't be cleanly distinguished from an
    // Adobe-managed offering — CloudFront vs AMS-CloudFront, Azure vs
    // AMS-FrontDoor — collapses to 'byocdn-other'. Same for everything
    // without a dedicated UI radio (Vercel, Netlify, etc.).
    const headerCases = [
      { name: 'Cloudflare (cf-ray)', headers: { 'cf-ray': 'abc' }, token: 'byocdn-cloudflare' },
      { name: 'Akamai (x-akamai-transformed)', headers: { 'x-akamai-transformed': '9' }, token: 'byocdn-akamai' },
      { name: 'Akamai (akamai-grn)', headers: { 'akamai-grn': '0.abc123.1234567.deadbeef' }, token: 'byocdn-akamai' },
      { name: 'Fastly BYOCDN (x-fastly-request-id)', headers: { 'x-fastly-request-id': 'abc' }, token: 'byocdn-fastly' },
      { name: 'CloudFront (x-amz-cf-id)', headers: { 'x-amz-cf-id': 'abc' }, token: 'byocdn-other' },
      { name: 'Imperva (x-iinfo)', headers: { 'x-iinfo': 'a' }, token: 'byocdn-imperva' },
      { name: 'Azure combined (x-azure-ref)', headers: { 'x-azure-ref': 'a' }, token: 'byocdn-other' },
      { name: 'Azure CDN (x-ec-debug)', headers: { 'x-ec-debug': 'a' }, token: 'byocdn-other' },
      { name: 'Azure Front Door (x-fd-healthprobe)', headers: { 'x-fd-healthprobe': '1' }, token: 'byocdn-other' },
      { name: 'Google Cloud CDN (x-goog-*)', headers: { 'x-goog-foo': '1' }, token: 'byocdn-other' },
      { name: 'Vercel (x-vercel-id)', headers: { 'x-vercel-id': '1' }, token: 'byocdn-other' },
      { name: 'Netlify (x-nf-request-id)', headers: { 'x-nf-request-id': '1' }, token: 'byocdn-other' },
      { name: 'KeyCDN (x-edge-location)', headers: { 'x-edge-location': '1' }, token: 'byocdn-other' },
      { name: 'Limelight (x-llid)', headers: { 'x-llid': '1' }, token: 'byocdn-other' },
      { name: 'CDNetworks (x-cdn-request-id)', headers: { 'x-cdn-request-id': '1' }, token: 'byocdn-other' },
      { name: 'Bunny CDN (x-bunny-*)', headers: { 'x-bunny-foo': '1' }, token: 'byocdn-other' },
      { name: 'StackPath (server: NetDNA)', headers: { server: 'NetDNA-cache' }, token: 'byocdn-other' },
      { name: 'Sucuri (x-sucuri-id)', headers: { 'x-sucuri-id': '1' }, token: 'byocdn-other' },
    ];

    for (const { name, headers, token } of headerCases) {
      // eslint-disable-next-line no-loop-func
      it(`maps ${name} header to ${token}`, async () => {
        probeReturns(headers);
        const result = await detectCdnForDomain('example.com');
        expect(result).to.equal(token);
      });
    }

    it('returns other when HTTP probe fails and DNS fallback finds nothing', async () => {
      // fetchStub default rejects everything; DNS fallback also misses.
      const result = await detectCdnForDomain('example.com');
      expect(result).to.equal('byocdn-other');
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

    it('detects via PTR keyword (Akamai PTR record)', async () => {
      dnsStubs.reverse.resolves(['a23-45-67-89.deploy.static.akamaitechnologies.com']);
      const result = await detectCdnForDomain('example.com');
      expect(result).to.equal('byocdn-akamai');
    });

    it('Phase 1 wins over Phase 2: AEM CS Fastly DNS match short-circuits HTTP probe', async () => {
      dnsStubs.resolveCname.withArgs('www.example.com').resolves(['cdn.adobeaemcloud.com.']);
      probeReturns({ 'cf-ray': 'should-be-skipped' });

      const result = await detectCdnForDomain('example.com');
      expect(result).to.equal('aem-cs-fastly');

      const probedSite = fetchStub.getCalls().some((c) => {
        const url = c.args[0];
        return typeof url === 'string' && url.includes('example.com');
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

    // -----------------------------------------------------------------
    // Additional coverage tests: exercise the keyword-blob fallback
    // and PTR domain-signature path so every reachable branch in
    // cdn-detection.js is hit.
    // -----------------------------------------------------------------

    it('returns other when probe responds 200 with no identifying headers (empty keyword blob)', async () => {
      probeReturns({});
      const result = await detectCdnForDomain('example.com');
      expect(result).to.equal('byocdn-other');
    });

    it('detects via header keyword blob (x-cdn-forward: cachefly → byocdn-other after collapse)', async () => {
      probeReturns({ 'x-cdn-forward': 'cachefly-edge-server' });
      const result = await detectCdnForDomain('example.com');
      expect(result).to.equal('byocdn-other');
    });

    it('detects via CNAME keyword (no domain-suffix match): edge.cachefly.mycorp.com → byocdn-other', async () => {
      dnsStubs.resolveCname.resolves(['edge.cachefly.mycorp.com']);
      const result = await detectCdnForDomain('example.com');
      expect(result).to.equal('byocdn-other');
    });

    it('detects via PTR domain signature (no keyword match): googleusercontent.com → byocdn-other', async () => {
      dnsStubs.reverse.resolves(['x.googleusercontent.com']);
      const result = await detectCdnForDomain('example.com');
      expect(result).to.equal('byocdn-other');
    });

    it('treats empty PTR hostname list as no PTR match (covers reverse → [] branch)', async () => {
      dnsStubs.reverse.resolves([]);
      const result = await detectCdnForDomain('example.com');
      expect(result).to.equal('byocdn-other');
    });

    it('handles non-Error rejections from HEAD and GET probes gracefully', async () => {
      fetchStub.callsFake((url, opts) => {
        if (url.startsWith('https://example.com') || url.startsWith('https://www.example.com')) {
          if (opts?.method === 'HEAD') {
            // eslint-disable-next-line prefer-promise-reject-errors
            return Promise.reject('head-string-error');
          }
          // eslint-disable-next-line prefer-promise-reject-errors
          return Promise.reject('get-string-error');
        }
        return Promise.reject(new Error('blocked'));
      });
      const result = await detectCdnForDomain('example.com');
      expect(result).to.equal('byocdn-other');
    });
  });

  // -----------------------------------------------------------------------
  // Phase 2 logging — exercises every log?.info? / log?.warn? branch so we
  // hit the "log is provided" path in addition to the existing "no log"
  // paths the phase-2 tests above already cover.
  // -----------------------------------------------------------------------
  describe('phase 2 — logging', () => {
    let log;

    beforeEach(() => {
      log = { info: sinon.stub(), warn: sinon.stub() };
      dnsStubs.resolveCname.resolves(['no-match.example.net.']);
      dnsStubs.resolve4.resolves(['1.2.3.4']);
      dnsStubs.resolve6.resolves([]);
    });

    it('logs warn on HEAD failure and reverse DNS failure', async () => {
      // fetchStub default rejects everything → HEAD/GET fail.
      // dnsStubs.reverse default rejects ENOTFOUND → reverse DNS failure is logged.
      await detectCdnForDomain('example.com', log);
      expect(log.warn).to.have.been.calledWith(sinon.match(/HEAD failed/));
      expect(log.warn).to.have.been.calledWith('[cdn-detection] reverse DNS failed', sinon.match.any);
    });

    it('logs warn when Phase 2 getCnameChain encounters a non-ENODATA error', async () => {
      // Keep Phase 1 www.example.com clean so we still run Phase 2.
      dnsStubs.resolveCname.withArgs('www.example.com').resolves(['no-match.example.net.']);
      dnsStubs.resolveCname.withArgs('example.com').rejects(dnsError('SERVFAIL'));
      await detectCdnForDomain('example.com', log);
      expect(log.warn).to.have.been.calledWith('[cdn-detection] CNAME resolve error', sinon.match.any);
    });

    it('logs warn when Phase 2 getOneIp resolve4 rejects', async () => {
      // Phase 1 www still returns byocdn-other via default resolve4 for www.example.com.
      dnsStubs.resolve4.withArgs('www.example.com').resolves(['1.2.3.4']);
      dnsStubs.resolve4.withArgs('example.com').rejects(dnsError('SERVFAIL'));
      await detectCdnForDomain('example.com', log);
      expect(log.warn).to.have.been.calledWith('[cdn-detection] resolve4 error', sinon.match.any);
    });

    it('logs info when Phase 2 detects via CNAME suffix (system resolver)', async () => {
      dnsStubs.resolveCname.resolves(['edge.cloudflare.com']);
      const result = await detectCdnForDomain('example.com', log);
      expect(result).to.equal('byocdn-cloudflare');
      expect(log.info).to.have.been.calledWith('[cdn-detection] Phase 2: detected by CNAME', sinon.match.any);
    });

    it('logs info when Phase 2 detects via DNS name keywords (system chain)', async () => {
      dnsStubs.resolveCname.resolves(['edge.cachefly.mycorp.com']);
      const result = await detectCdnForDomain('example.com', log);
      expect(result).to.equal('byocdn-other');
      expect(log.info).to.have.been.calledWith('[cdn-detection] Phase 2: detected by DNS name keywords', sinon.match.any);
    });

    it('logs info when Phase 2 detects via PTR keywords', async () => {
      dnsStubs.reverse.resolves(['a1.deploy.static.akamaitechnologies.com']);
      const result = await detectCdnForDomain('example.com', log);
      expect(result).to.equal('byocdn-akamai');
      expect(log.info).to.have.been.calledWith('[cdn-detection] Phase 2: detected by PTR keywords', sinon.match.any);
    });

    it('logs info when Phase 2 detects via PTR CNAME signature', async () => {
      dnsStubs.reverse.resolves(['x.googleusercontent.com']);
      const result = await detectCdnForDomain('example.com', log);
      expect(result).to.equal('byocdn-other');
      expect(log.info).to.have.been.calledWith('[cdn-detection] Phase 2: detected by PTR CNAME signature', sinon.match.any);
    });
  });

  // -----------------------------------------------------------------------
  // SSRF mitigation, suffix-anchored CNAME, probeSucceeded null-vs-other
  // semantics, and timer-leak coverage for changes landing alongside the
  // LABEL_TO_LLMO_TOKEN collapse.
  // -----------------------------------------------------------------------
  describe('input hardening and probe-success semantics', () => {
    let log;

    beforeEach(() => {
      log = { info: sinon.stub(), warn: sinon.stub() };
    });

    it('rejects http:// inputs (SSRF mitigation) without resolving DNS', async () => {
      const result = await detectCdnForDomain('http://example.com', log);
      expect(result).to.be.null;
      expect(dnsStubs.resolveCname).to.not.have.been.called;
      expect(log.info).to.have.been.calledWith(
        '[cdn-detection] Rejecting non-https input',
        sinon.match.has('input', 'http://example.com'),
      );
    });

    it('rejects ftp:// and other non-https schemes', async () => {
      const result = await detectCdnForDomain('ftp://example.com');
      expect(result).to.be.null;
    });

    it('does not match a CNAME that contains the signature as a non-suffix substring', async () => {
      // Ports the audit-worker fix: substring includes() in matchCdnByCname
      // would have classified this as Azure; suffix-anchored matching
      // correctly rejects it. We deliberately pick azureedge.net here because
      // it is in CDN_DOMAIN_SIGNATURES but has no matching CDN_KEYWORD_SIGNATURES
      // entry, so the keyword-fallback path can't accidentally re-classify it.
      dnsStubs.resolveCname.resolves(['edge.azureedge.net.attacker.example']);
      dnsStubs.resolve4.resolves(['1.2.3.4']);
      const result = await detectCdnForDomain('example.com');
      expect(result).to.equal('byocdn-other');
    });

    it('returns other when Phase 1 misses cleanly AND at least one Phase 2 probe ran (DNS chain present)', async () => {
      // Phase 1: clean miss. Phase 2: HTTP probe rejects, but the system
      // resolver returned a non-empty (non-matching) chain. probeSucceeded=true
      // → byocdn-other (not null).
      dnsStubs.resolveCname.resolves(['no-match.example.net.']);
      dnsStubs.resolve4.resolves(['1.2.3.4']);
      const result = await detectCdnForDomain('example.com');
      expect(result).to.equal('byocdn-other');
    });

    it('returns null when both phases fail outright (no signal anywhere)', async () => {
      // Phase 1: SERVFAIL. Phase 2: HTTP probes reject, DNS lookup yields
      // nothing. probeSucceeded=false everywhere → null instead of byocdn-other.
      dnsStubs.resolveCname.rejects(dnsError('SERVFAIL'));
      dnsStubs.resolve4.rejects(dnsError('SERVFAIL'));
      dnsStubs.resolve6.rejects(dnsError('SERVFAIL'));
      const result = await detectCdnForDomain('example.com');
      expect(result).to.be.null;
    });
  });
});
