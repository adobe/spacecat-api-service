/* eslint-disable */
import { expect } from 'chai';
import { detectCdnForDomain } from '../../src/support/cdn-detection.js';
import { detectAemCsFastlyForDomain } from '../../src/support/edge-routing-utils.js';

const DOMAINS = [
  // Case 0 (WAF simple proxy — routing already active, auto-routed via CDN API)
  { domain: 'www.cpkcr.com',          expectedOnboard: 'aem-cs-fastly',              expectedEnable: 'aem-cs-fastly'              },
  { domain: 'www.birlaopus.com',      expectedOnboard: 'aem-cs-fastly',              expectedEnable: 'aem-cs-fastly'              },
  { domain: 'www.au.bank.in',         expectedOnboard: 'aem-cs-fastly',              expectedEnable: 'aem-cs-fastly'              },
  // Cases 1 & 2 (BYO CDN — customer must apply routing YAML manually)
  { domain: 'www.tatapower.com',      expectedOnboard: 'aem-cs-fastly-simple-proxy', expectedEnable: 'aem-cs-fastly-simple-proxy' },
  { domain: 'www.indiafirstlife.com', expectedOnboard: 'aem-cs-fastly-simple-proxy', expectedEnable: 'aem-cs-fastly-simple-proxy' },
  // Non-AEM / unknown
  { domain: 'www.spark.co.nz',        expectedOnboard: 'byocdn-other',               expectedEnable: null                         },
];

describe('CDN Detection — live domain tests', function () {
  this.timeout(30000);

  for (const { domain, expectedOnboard, expectedEnable } of DOMAINS) {
    describe(domain, () => {
      it(`detectCdnForDomain (onboarding) → ${expectedOnboard ?? 'null'}`, async () => {
        const result = await detectCdnForDomain(domain);
        console.log(`        result: ${result}`);
        expect(result).to.equal(expectedOnboard);
      });

      it(`detectAemCsFastlyForDomain (+Enable) → ${expectedEnable ?? 'null'}`, async () => {
        const result = await detectAemCsFastlyForDomain(domain);
        console.log(`        result: ${result}`);
        expect(result).to.equal(expectedEnable);
      });
    });
  }
});
