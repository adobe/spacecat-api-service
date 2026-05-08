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

import { expect } from 'chai';
import { generateAkamaiPapiConfig } from '../../src/support/akamai-papi-template.js';

describe('generateAkamaiPapiConfig', () => {
  const TEST_DOMAIN = 'www.example.com';
  const TEST_API_KEY = 'test-api-key-12345';

  let config;

  beforeEach(() => {
    config = generateAkamaiPapiConfig(TEST_DOMAIN, TEST_API_KEY);
  });

  it('returns a valid PAPI structure with rules.name === "default"', () => {
    expect(config).to.be.an('object');
    expect(config.rules).to.be.an('object');
    expect(config.rules.name).to.equal('default');
  });

  it('includes the domain in rules.comments', () => {
    expect(config.rules.comments).to.include(TEST_DOMAIN);
  });

  it('has PMUSER_EDGE_OPTIMIZE_CACHE_KEY variable defined', () => {
    const variable = config.rules.variables.find(
      (v) => v.name === 'PMUSER_EDGE_OPTIMIZE_CACHE_KEY',
    );
    expect(variable).to.exist;
    expect(variable.hidden).to.equal(false);
    expect(variable.sensitive).to.equal(false);
  });

  it('has a child rule named "Edge Optimize – AI Bot Routing"', () => {
    expect(config.rules.children).to.be.an('array').with.lengthOf(1);
    const childRule = config.rules.children[0];
    expect(childRule.name).to.equal('Edge Optimize – AI Bot Routing');
  });

  it('has criteriaMustSatisfy === "all" on the child rule', () => {
    const childRule = config.rules.children[0];
    expect(childRule.criteriaMustSatisfy).to.equal('all');
  });

  it('child rule comments include domain', () => {
    const childRule = config.rules.children[0];
    expect(childRule.comments).to.include(TEST_DOMAIN);
  });

  it('user-agent criteria includes *GPTBot*', () => {
    const childRule = config.rules.children[0];
    const uaCriteria = childRule.criteria.find((c) => c.name === 'userAgent');
    expect(uaCriteria).to.exist;
    expect(uaCriteria.options.values).to.include('*GPTBot*');
  });

  it('user-agent criteria includes *ChatGPT-User*', () => {
    const childRule = config.rules.children[0];
    const uaCriteria = childRule.criteria.find((c) => c.name === 'userAgent');
    expect(uaCriteria.options.values).to.include('*ChatGPT-User*');
  });

  it('user-agent criteria includes *anthropic-ai*', () => {
    const childRule = config.rules.children[0];
    const uaCriteria = childRule.criteria.find((c) => c.name === 'userAgent');
    expect(uaCriteria.options.values).to.include('*anthropic-ai*');
  });

  it('user-agent criteria includes *PerplexityBot*', () => {
    const childRule = config.rules.children[0];
    const uaCriteria = childRule.criteria.find((c) => c.name === 'userAgent');
    expect(uaCriteria.options.values).to.include('*PerplexityBot*');
  });

  it('file extension criteria uses IS_NOT_ONE_OF operator', () => {
    const childRule = config.rules.children[0];
    const extCriteria = childRule.criteria.find((c) => c.name === 'fileExtension');
    expect(extCriteria).to.exist;
    expect(extCriteria.options.matchOperator).to.equal('IS_NOT_ONE_OF');
  });

  it('file extension criteria includes "css" and "js"', () => {
    const childRule = config.rules.children[0];
    const extCriteria = childRule.criteria.find((c) => c.name === 'fileExtension');
    expect(extCriteria.options.values).to.include('css');
    expect(extCriteria.options.values).to.include('js');
  });

  it('origin behavior has hostname === "live.edgeoptimize.net"', () => {
    const childRule = config.rules.children[0];
    const originBehavior = childRule.behaviors.find((b) => b.name === 'origin');
    expect(originBehavior).to.exist;
    expect(originBehavior.options.hostname).to.equal('live.edgeoptimize.net');
  });

  it('origin customValidCnValues includes "*.edgeoptimize.net"', () => {
    const childRule = config.rules.children[0];
    const originBehavior = childRule.behaviors.find((b) => b.name === 'origin');
    expect(originBehavior.options.customValidCnValues).to.include('*.edgeoptimize.net');
  });

  it('x-edgeoptimize-api-key header value equals the passed apiKey', () => {
    const childRule = config.rules.children[0];
    const apiKeyBehavior = childRule.behaviors.find(
      (b) => b.name === 'modifyIncomingRequestHeader'
        && b.options.headerName === 'x-edgeoptimize-api-key',
    );
    expect(apiKeyBehavior).to.exist;
    expect(apiKeyBehavior.options.headerValue).to.equal(TEST_API_KEY);
  });

  it('x-edgeoptimize-config header value equals "LLMCLIENT=TRUE;"', () => {
    const childRule = config.rules.children[0];
    const configBehavior = childRule.behaviors.find(
      (b) => b.name === 'modifyIncomingRequestHeader'
        && b.options.headerName === 'x-edgeoptimize-config',
    );
    expect(configBehavior).to.exist;
    expect(configBehavior.options.headerValue).to.equal('LLMCLIENT=TRUE;');
  });

  it('x-forwarded-host outgoing header uses "{{builtin.AK_HOST}}"', () => {
    const childRule = config.rules.children[0];
    const fwdHostBehavior = childRule.behaviors.find(
      (b) => b.name === 'modifyOutgoingRequestHeader'
        && b.options.headerName === 'x-forwarded-host',
    );
    expect(fwdHostBehavior).to.exist;
    expect(fwdHostBehavior.options.headerValue).to.equal('{{builtin.AK_HOST}}');
  });

  it('setVariable behavior for PMUSER_EDGE_OPTIMIZE_CACHE_KEY includes LLMCLIENT=TRUE and {{builtin.AK_HOST}}', () => {
    const childRule = config.rules.children[0];
    const setVarBehavior = childRule.behaviors.find((b) => b.name === 'setVariable');
    expect(setVarBehavior).to.exist;
    expect(setVarBehavior.options.variableName).to.equal('PMUSER_EDGE_OPTIMIZE_CACHE_KEY');
    expect(setVarBehavior.options.variableValue).to.include('LLMCLIENT=TRUE');
    expect(setVarBehavior.options.variableValue).to.include('{{builtin.AK_HOST}}');
  });

  it('has no failover behavior (simplified config)', () => {
    const childRule = config.rules.children[0];
    const failoverBehavior = childRule.behaviors.find((b) => b.name === 'failoverOrigin' || b.name === 'failover');
    expect(failoverBehavior).to.be.undefined;
    expect(childRule.children).to.be.an('array').with.lengthOf(0);
  });

  it('has empty behaviors array at the top-level rules', () => {
    expect(config.rules.behaviors).to.be.an('array').with.lengthOf(0);
  });

  it('has options.is_secure === false at top level', () => {
    expect(config.rules.options).to.deep.equal({ is_secure: false });
  });
});
