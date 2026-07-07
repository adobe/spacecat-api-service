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
import {
  EDGE_OPTIMIZE_DEFAULTS,
  buildRuleConfig,
  buildParentRule,
  buildRoutingRule,
  buildSiteFailoverRule,
  buildFailoverTestRule,
  buildFragments,
  mergeIntoTree,
  managedRuleNames,
} from '../../../src/controllers/llmo/llmo-akamai-utils.js';

const HOSTNAME = 'www.example.com';
const API_KEY = 'llmo-api-key-xyz';

const findBehavior = (rule, name) => rule.behaviors.find((b) => b.name === name);
const findCriterion = (rule, name) => rule.criteria.find((c) => c.name === name);

describe('llmo-akamai-utils', () => {
  describe('buildRuleConfig', () => {
    it('injects the site hostname and API key into a defaults-based config', () => {
      const cfg = buildRuleConfig({ hostname: HOSTNAME, apiKey: API_KEY });
      expect(cfg.match.hostnames).to.deep.equal([HOSTNAME]);
      expect(cfg.match.userAgents).to.deep.equal(EDGE_OPTIMIZE_DEFAULTS.userAgents);
      expect(cfg.incomingRequestHeaders['x-edgeoptimize-api-key']).to.equal(API_KEY);
      expect(cfg.failover.alternateHostname).to.equal(HOSTNAME);
      expect(cfg.origin.hostname).to.equal('live.edgeoptimize.net');
    });

    it('does not mutate the frozen defaults', () => {
      const cfg = buildRuleConfig({ hostname: HOSTNAME, apiKey: API_KEY });
      cfg.match.userAgents.push('EvilBot');
      expect(EDGE_OPTIMIZE_DEFAULTS.userAgents).to.not.include('EvilBot');
    });
  });

  describe('buildRoutingRule', () => {
    let cfg;
    let routing;
    beforeEach(() => {
      cfg = buildRuleConfig({ hostname: HOSTNAME, apiKey: API_KEY });
      routing = buildRoutingRule(cfg);
    });

    it('is named from the config and scoped to the site hostname', () => {
      expect(routing.name).to.equal(cfg.ruleNames.routing);
      const host = findCriterion(routing, 'hostname');
      expect(host.options.values).to.deep.equal([HOSTNAME]);
      expect(host.options.matchOperator).to.equal('IS_ONE_OF');
    });

    it('matches AI-bot user agents and HTML/extensionless files', () => {
      expect(findCriterion(routing, 'userAgent').options.matchWildcard).to.equal(true);
      const ext = findCriterion(routing, 'fileExtension');
      expect(ext.options.values).to.include('EMPTY_STRING');
      expect(ext.options.values).to.include('html');
    });

    it('sets the Edge Optimize origin with custom SAN and both CA sets', () => {
      const origin = findBehavior(routing, 'origin');
      expect(origin.options.hostname).to.equal('live.edgeoptimize.net');
      expect(origin.options.customValidCnValues).to.include('*.edgeoptimize.net');
      expect(origin.options.standardCertificateAuthorities).to.include('THIRD_PARTY_AMAZON');
      expect(origin.options.trueClientIpClientSetting).to.equal(true);
    });

    it('injects the api key header and folds the cache-key variable into the cache id', () => {
      const apiKeyHeader = routing.behaviors.find(
        (b) => b.name === 'modifyIncomingRequestHeader' && b.options.customHeaderName === 'x-edgeoptimize-api-key',
      );
      expect(apiKeyHeader.options.headerValue).to.equal(API_KEY);
      const cacheId = findBehavior(routing, 'cacheId');
      expect(cacheId.options.variableName).to.equal(cfg.cacheKeyVariable.name);
    });

    it('guards against re-routing an already-failed-over request', () => {
      const guards = routing.criteria.filter(
        (c) => c.name === 'requestHeader' && c.options.matchOperator === 'DOES_NOT_EXIST',
      );
      const guardedHeaders = guards.map((g) => g.options.headerName);
      expect(guardedHeaders).to.include('x-edgeoptimize-api-key');
      expect(guardedHeaders).to.include('x-edgeoptimize-request');
    });

    it('nests a Site Failover child rule pointing back at the site hostname', () => {
      expect(routing.children).to.have.length(1);
      const failover = routing.children[0];
      expect(failover.name).to.equal('Site Failover Behavior');
      expect(findBehavior(failover, 'failAction').options.contentHostname).to.equal(HOSTNAME);
    });

    it('adds the WAF-bypass header only when enabled', () => {
      const cfgWaf = buildRuleConfig({ hostname: HOSTNAME, apiKey: API_KEY });
      cfgWaf.wafBypass = { enabled: true, headerName: 'x-edgeoptimize-fetcher-key', value: 'secret' };
      const rule = buildRoutingRule(cfgWaf);
      const waf = rule.behaviors.find(
        (b) => b.name === 'modifyIncomingRequestHeader' && b.options.customHeaderName === 'x-edgeoptimize-fetcher-key',
      );
      expect(waf).to.not.equal(undefined);
    });
  });

  describe('buildSiteFailoverRule', () => {
    it('uses only the GA alternate-hostname behavior (no advanced metadata)', () => {
      const cfg = buildRuleConfig({ hostname: HOSTNAME, apiKey: API_KEY });
      const rule = buildSiteFailoverRule(cfg);
      expect(rule.criteriaMustSatisfy).to.equal('any');
      expect(findBehavior(rule, 'advanced')).to.equal(undefined);
      const failAction = findBehavior(rule, 'failAction');
      expect(failAction.options.contentHostname).to.equal(HOSTNAME);
      expect(rule.behaviors).to.have.length(1);
    });
  });

  describe('buildFailoverTestRule', () => {
    it('detects the failover recreate via persisted api-key + absent marker (no advanced metadata)', () => {
      const cfg = buildRuleConfig({ hostname: HOSTNAME, apiKey: API_KEY });
      const rule = buildFailoverTestRule(cfg);
      expect(rule.criteriaMustSatisfy).to.equal('all');
      const ops = Object.fromEntries(
        rule.criteria
          .filter((c) => c.name === 'requestHeader')
          .map((c) => [c.options.headerName, c.options.matchOperator]),
      );
      expect(ops['x-edgeoptimize-api-key']).to.equal('EXISTS');
      expect(ops['x-edgeoptimize-request']).to.equal('DOES_NOT_EXIST');
      const resp = findBehavior(rule, 'modifyOutgoingResponseHeader');
      expect(resp.options.customHeaderName).to.equal('x-edgeoptimize-fo');
      expect(resp.options.headerValue).to.equal('true');
    });
  });

  describe('buildParentRule / buildFragments', () => {
    it('wraps the routing rule and its failover-test sibling under one parent', () => {
      const cfg = buildRuleConfig({ hostname: HOSTNAME, apiKey: API_KEY });
      const parent = buildParentRule(cfg);
      expect(parent.name).to.equal(cfg.ruleNames.parent);
      expect(parent.children.map((c) => c.name)).to.deep.equal([
        cfg.ruleNames.routing,
        cfg.ruleNames.failoverTest,
      ]);
      expect(buildFragments(cfg).parentRule.name).to.equal(cfg.ruleNames.parent);
    });
  });

  describe('managedRuleNames', () => {
    it('returns the parent, routing, and failover-test rule names', () => {
      const cfg = buildRuleConfig({ hostname: HOSTNAME, apiKey: API_KEY });
      expect(managedRuleNames(cfg)).to.deep.equal([
        cfg.ruleNames.parent,
        cfg.ruleNames.routing,
        cfg.ruleNames.failoverTest,
      ]);
    });
  });

  describe('mergeIntoTree', () => {
    let cfg;
    let baseTree;
    beforeEach(() => {
      cfg = buildRuleConfig({ hostname: HOSTNAME, apiKey: API_KEY });
      baseTree = {
        rules: {
          name: 'default',
          children: [{ name: 'Existing Rule', children: [] }],
          variables: [],
        },
      };
    });

    it('inserts the managed wrapper as the first child by default and declares the cache variable', () => {
      const merged = mergeIntoTree(baseTree, cfg);
      expect(merged.rules.children[0].name).to.equal(cfg.ruleNames.parent);
      expect(merged.rules.children.map((c) => c.name)).to.include('Existing Rule');
      const declared = merged.rules.variables.some((v) => v.name === cfg.cacheKeyVariable.name);
      expect(declared).to.equal(true);
    });

    it('does not mutate the input tree', () => {
      mergeIntoTree(baseTree, cfg);
      expect(baseTree.rules.children.map((c) => c.name)).to.deep.equal(['Existing Rule']);
    });

    it('is idempotent — re-merging replaces rather than duplicating the managed rule', () => {
      const once = mergeIntoTree(baseTree, cfg);
      const twice = mergeIntoTree(once, cfg);
      const parents = twice.rules.children.filter((c) => c.name === cfg.ruleNames.parent);
      expect(parents).to.have.length(1);
    });

    it('strips leftover flat routing/failover-test rules from the older layout', () => {
      const flatTree = {
        rules: {
          name: 'default',
          children: [
            { name: cfg.ruleNames.routing, children: [] },
            { name: cfg.ruleNames.failoverTest, children: [] },
            { name: 'Existing Rule', children: [] },
          ],
          variables: [],
        },
      };
      const merged = mergeIntoTree(flatTree, cfg);
      const names = merged.rules.children.map((c) => c.name);
      expect(names).to.deep.equal([cfg.ruleNames.parent, 'Existing Rule']);
    });

    it('honors insertIndex, clamped to the existing children length', () => {
      const merged = mergeIntoTree(baseTree, cfg, 99);
      expect(merged.rules.children[merged.rules.children.length - 1].name)
        .to.equal(cfg.ruleNames.parent);
    });

    it('does not duplicate an already-declared cache variable', () => {
      baseTree.rules.variables.push({ name: cfg.cacheKeyVariable.name, value: '' });
      const merged = mergeIntoTree(baseTree, cfg);
      const count = merged.rules.variables.filter(
        (v) => v.name === cfg.cacheKeyVariable.name,
      ).length;
      expect(count).to.equal(1);
    });

    it('creates a variables array when the tree has none', () => {
      const treeNoVars = { rules: { name: 'default', children: [] } };
      const merged = mergeIntoTree(treeNoVars, cfg);
      expect(merged.rules.variables).to.be.an('array').with.length(1);
    });

    it('throws when the tree has no top-level rules object', () => {
      expect(() => mergeIntoTree({}, cfg)).to.throw("missing a top-level 'rules' object");
    });
  });

  describe('branch coverage — edge configs', () => {
    const base = () => buildRuleConfig({ hostname: HOSTNAME, apiKey: API_KEY });

    it('converts an empty-string file extension to EMPTY_STRING', () => {
      const cfg = base();
      cfg.match.fileExtensions = ['html', ''];
      const rule = buildRoutingRule(cfg);
      expect(findCriterion(rule, 'fileExtension').options.values).to.include('EMPTY_STRING');
    });

    it('omits the hostname criterion when hostnames are absent', () => {
      const cfg = base();
      delete cfg.match.hostnames;
      const rule = buildRoutingRule(cfg);
      expect(findCriterion(rule, 'hostname')).to.equal(undefined);
    });

    it('tolerates a config without removeIncomingResponseHeaders', () => {
      const cfg = base();
      delete cfg.removeIncomingResponseHeaders;
      const rule = buildRoutingRule(cfg);
      expect(rule.behaviors.some((b) => b.name === 'modifyIncomingResponseHeader')).to.equal(false);
    });

    it('falls back to the first incoming header for the loop guard when the api-key header is absent', () => {
      const cfg = base();
      cfg.incomingRequestHeaders = { 'x-custom-first': 'v', 'x-edgeoptimize-config': 'c' };
      const rule = buildRoutingRule(cfg);
      const guards = rule.criteria.filter(
        (c) => c.name === 'requestHeader' && c.options.matchOperator === 'DOES_NOT_EXIST',
      );
      expect(guards.map((g) => g.options.headerName)).to.include('x-custom-first');
    });

    it('merges into a tree whose default rule has no children array', () => {
      const cfg = base();
      const merged = mergeIntoTree({ rules: { name: 'default', variables: [] } }, cfg);
      expect(merged.rules.children[0].name).to.equal(cfg.ruleNames.parent);
    });

    it('clamps a negative insertIndex to 0', () => {
      const cfg = base();
      const tree = { rules: { name: 'default', children: [{ name: 'A' }], variables: [] } };
      const merged = mergeIntoTree(tree, cfg, -5);
      expect(merged.rules.children[0].name).to.equal(cfg.ruleNames.parent);
    });
  });
});
