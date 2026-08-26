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
  managedRuleTree,
  buildRoutingEdgeRule,
  buildRoutingParentRule,
  buildRemoveMarkerRule,
  buildSiteFailoverRule,
  buildFailoverTestRule,
  buildFragments,
  mergeIntoTree,
  buildRuleTreePatch,
  managedRuleNames,
  detectManagedRuleNames,
  estimateRuleTreeComplexity,
  getManagedFetcherKey,
  redactSecrets,
  redactPapiErrors,
} from '../../../src/controllers/llmo/llmo-akamai-utils.js';

const EDGE_ROUTED_MARKER = 'x-edgeoptimize-edge-routed';
const LEGACY_ROUTING_NAME = 'Optimize at Edge Routing';

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

    it('routes to the given originHostname (env EDGE_OPTIMIZE_EDGE_DOMAIN) over the default', () => {
      const cfg = buildRuleConfig({
        hostname: HOSTNAME, apiKey: API_KEY, originHostname: 'dev.edgeoptimize.net',
      });
      expect(cfg.origin.hostname).to.equal('dev.edgeoptimize.net');
      // matchSan still covers all envs, so CUSTOM cert validation works for dev/stage/live.
      expect(cfg.origin.matchSan).to.equal('*.edgeoptimize.net');
    });

    it('falls back to the default origin for a blank/whitespace originHostname', () => {
      const cfg = buildRuleConfig({ hostname: HOSTNAME, apiKey: API_KEY, originHostname: '   ' });
      expect(cfg.origin.hostname).to.equal('live.edgeoptimize.net');
    });

    it('does not mutate the frozen defaults', () => {
      const cfg = buildRuleConfig({ hostname: HOSTNAME, apiKey: API_KEY });
      cfg.match.userAgents.push('EvilBot');
      expect(EDGE_OPTIMIZE_DEFAULTS.userAgents).to.not.include('EvilBot');
    });

    it('adds the x-edgeoptimize-fetcher-key header when a fetcherKey is provided (trimmed)', () => {
      const cfg = buildRuleConfig({ hostname: HOSTNAME, apiKey: API_KEY, fetcherKey: '  secret-123 \n' });
      expect(cfg.incomingRequestHeaders['x-edgeoptimize-fetcher-key']).to.equal('secret-123');
    });

    it('omits the fetcher-key header when fetcherKey is absent or blank', () => {
      const none = buildRuleConfig({ hostname: HOSTNAME, apiKey: API_KEY });
      expect(none.incomingRequestHeaders).to.not.have.property('x-edgeoptimize-fetcher-key');
      const blank = buildRuleConfig({ hostname: HOSTNAME, apiKey: API_KEY, fetcherKey: '   ' });
      expect(blank.incomingRequestHeaders).to.not.have.property('x-edgeoptimize-fetcher-key');
    });
  });

  describe('buildRoutingEdgeRule', () => {
    let cfg;
    let edge;
    beforeEach(() => {
      cfg = buildRuleConfig({ hostname: HOSTNAME, apiKey: API_KEY });
      edge = buildRoutingEdgeRule(cfg);
    });

    it('is named "Routing Edge" and matches the client-facing pass (CLIENT_REQ + api-key absent)', () => {
      expect(edge.name).to.equal(cfg.ruleNames.routingEdge);
      const requestType = findCriterion(edge, 'requestType');
      expect(requestType.options.matchOperator).to.equal('IS');
      expect(requestType.options.value).to.equal('CLIENT_REQ');
      const guard = edge.criteria.find(
        (c) => c.name === 'requestHeader' && c.options.headerName === 'x-edgeoptimize-api-key',
      );
      expect(guard.options.matchOperator).to.equal('DOES_NOT_EXIST');
    });

    it('sets the Edge Optimize origin with custom SAN and both CA sets', () => {
      const origin = findBehavior(edge, 'origin');
      expect(origin.options.hostname).to.equal('live.edgeoptimize.net');
      expect(origin.options.customValidCnValues).to.include('*.edgeoptimize.net');
      expect(origin.options.standardCertificateAuthorities).to.include('THIRD_PARTY_AMAZON');
      expect(origin.options.trueClientIpClientSetting).to.equal(true);
    });

    it('injects the api key header via MODIFY (newHeaderValue) and folds the cache-key variable into the cache id', () => {
      const apiKeyHeader = edge.behaviors.find(
        (b) => b.name === 'modifyIncomingRequestHeader' && b.options.customHeaderName === 'x-edgeoptimize-api-key',
      );
      expect(apiKeyHeader.options.action).to.equal('MODIFY');
      expect(apiKeyHeader.options.newHeaderValue).to.equal(API_KEY);
      expect(apiKeyHeader.options).to.not.have.property('headerValue');
      const cacheId = findBehavior(edge, 'cacheId');
      expect(cacheId.options.variableName).to.equal(cfg.cacheKeyVariable.name);
    });

    it('injects the internal edge-routed marker (=true) via MODIFY', () => {
      const marker = edge.behaviors.find(
        (b) => b.name === 'modifyIncomingRequestHeader' && b.options.customHeaderName === EDGE_ROUTED_MARKER,
      );
      expect(marker.options.action).to.equal('MODIFY');
      expect(marker.options.newHeaderValue).to.equal('true');
    });

    it('has no nested children (Site Failover is now a wrapper-level sibling)', () => {
      expect(edge.children).to.have.length(0);
    });

    it('adds the WAF-bypass header only when enabled', () => {
      const cfgWaf = buildRuleConfig({ hostname: HOSTNAME, apiKey: API_KEY });
      cfgWaf.wafBypass = { enabled: true, headerName: 'x-edgeoptimize-fetcher-key', value: 'secret' };
      const rule = buildRoutingEdgeRule(cfgWaf);
      const waf = rule.behaviors.find(
        (b) => b.name === 'modifyIncomingRequestHeader' && b.options.customHeaderName === 'x-edgeoptimize-fetcher-key',
      );
      expect(waf).to.not.equal(undefined);
    });
  });

  describe('buildRoutingParentRule', () => {
    let cfg;
    let parent;
    beforeEach(() => {
      cfg = buildRuleConfig({ hostname: HOSTNAME, apiKey: API_KEY });
      parent = buildRoutingParentRule(cfg);
    });

    it('is named "Routing Parent" and matches the parent pass (IS_NOT CLIENT_REQ + marker=true)', () => {
      expect(parent.name).to.equal(cfg.ruleNames.routingParent);
      const requestType = findCriterion(parent, 'requestType');
      expect(requestType.options.matchOperator).to.equal('IS_NOT');
      expect(requestType.options.value).to.equal('CLIENT_REQ');
      const marker = parent.criteria.find(
        (c) => c.name === 'requestHeader' && c.options.headerName === EDGE_ROUTED_MARKER,
      );
      expect(marker.options.matchOperator).to.equal('IS_ONE_OF');
      expect(marker.options.values).to.deep.equal(['true']);
    });

    it('re-applies the origin + cacheId but does NOT re-inject the credential headers', () => {
      expect(findBehavior(parent, 'origin').options.hostname).to.equal('live.edgeoptimize.net');
      expect(findBehavior(parent, 'cacheId')).to.not.equal(undefined);
      const injectsApiKey = parent.behaviors.some(
        (b) => b.name === 'modifyIncomingRequestHeader' && b.options.customHeaderName === 'x-edgeoptimize-api-key',
      );
      expect(injectsApiKey).to.equal(false);
    });

    it('nests only the marker-removal child (Site Failover is now a wrapper-level sibling)', () => {
      expect(parent.children.map((c) => c.name)).to.deep.equal([
        cfg.ruleNames.removeMarker,
      ]);
    });
  });

  describe('buildRemoveMarkerRule', () => {
    it('strips the edge-routed marker from the incoming request before origin', () => {
      const cfg = buildRuleConfig({ hostname: HOSTNAME, apiKey: API_KEY });
      const rule = buildRemoveMarkerRule(cfg);
      expect(rule.name).to.equal(cfg.ruleNames.removeMarker);
      expect(rule.criteria).to.deep.equal([]);
      const del = findBehavior(rule, 'modifyIncomingRequestHeader');
      expect(del.options.action).to.equal('DELETE');
      expect(del.options.customHeaderName).to.equal(EDGE_ROUTED_MARKER);
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
    it('wraps the two routing rules, the site-failover sibling, and the failover-test sibling', () => {
      const cfg = buildRuleConfig({ hostname: HOSTNAME, apiKey: API_KEY });
      const parent = buildParentRule(cfg);
      expect(parent.name).to.equal(cfg.ruleNames.parent);
      expect(parent.children.map((c) => c.name)).to.deep.equal([
        cfg.ruleNames.routingEdge,
        cfg.ruleNames.routingParent,
        'Site Failover Behavior',
        cfg.ruleNames.failoverTest,
      ]);
      expect(buildFragments(cfg).parentRule.name).to.equal(cfg.ruleNames.parent);
    });

    it('carries the shared gating criteria (hostname, user agents, file extension, loop guard)', () => {
      const cfg = buildRuleConfig({ hostname: HOSTNAME, apiKey: API_KEY });
      const parent = buildParentRule(cfg);
      expect(findCriterion(parent, 'hostname').options.values).to.deep.equal([HOSTNAME]);
      const ua = findCriterion(parent, 'userAgent');
      expect(ua.options.matchWildcard).to.equal(true);
      expect(ua.options.values).to.include('*GPTBot*');
      const ext = findCriterion(parent, 'fileExtension');
      expect(ext.options.values).to.include.members(['html', 'EMPTY_STRING']);
      // Worker-callback loop guard lives on the wrapper now.
      const guard = parent.criteria.find(
        (c) => c.name === 'requestHeader' && c.options.headerName === 'x-edgeoptimize-request',
      );
      expect(guard.options.matchOperator).to.equal('DOES_NOT_EXIST');
    });
  });

  describe('managedRuleNames', () => {
    it('returns the top-level rules to add (wrapper and failover-test), not legacy cleanup names', () => {
      const cfg = buildRuleConfig({ hostname: HOSTNAME, apiKey: API_KEY });
      expect(managedRuleNames(cfg)).to.deep.equal([
        cfg.ruleNames.parent,
        cfg.ruleNames.failoverTest,
      ]);
    });
  });

  describe('managedRuleTree', () => {
    it('returns the added wrapper hierarchy (names only, no secrets)', () => {
      const cfg = buildRuleConfig({ hostname: HOSTNAME, apiKey: API_KEY, fetcherKey: 'fk-secret' });
      const tree = managedRuleTree(cfg);
      expect(tree.name).to.equal(cfg.ruleNames.parent);
      expect(tree.children.map((c) => c.name)).to.deep.equal([
        cfg.ruleNames.routingEdge,
        cfg.ruleNames.routingParent,
        'Site Failover Behavior',
        cfg.ruleNames.failoverTest,
      ]);
      const parentRule = tree.children.find((c) => c.name === cfg.ruleNames.routingParent);
      expect(parentRule.children.map((c) => c.name)).to.deep.equal([cfg.ruleNames.removeMarker]);
      expect(JSON.stringify(tree)).to.not.contain('fk-secret');
    });
  });

  describe('detectManagedRuleNames', () => {
    it('returns [] for a tree with no managed rules', () => {
      const tree = { rules: { children: [{ name: 'Existing' }, { name: 'Other' }] } };
      expect(detectManagedRuleNames(tree)).to.deep.equal([]);
    });

    it('detects the wrapped layout (parent at top level)', () => {
      const tree = { rules: { children: [{ name: 'Existing' }, { name: 'ABV - Optimize at Edge' }] } };
      expect(detectManagedRuleNames(tree)).to.deep.equal(['ABV - Optimize at Edge']);
    });

    it('detects the legacy flat layout and a trailing-space name, deduped', () => {
      const tree = {
        rules: {
          children: [
            { name: 'Optimize at Edge Routing' },
            { name: 'EdgeOptimize Failover - Test Header' },
            { name: 'Optimize at Edge ' }, // legacy trailing space
          ],
        },
      };
      const found = detectManagedRuleNames(tree);
      expect(found).to.include.members([
        'Optimize at Edge',
        'Optimize at Edge Routing',
        'EdgeOptimize Failover - Test Header',
      ]);
      expect(found).to.have.length(3);
    });

    it('is safe on a missing/empty tree', () => {
      expect(detectManagedRuleNames(undefined)).to.deep.equal([]);
      expect(detectManagedRuleNames({})).to.deep.equal([]);
      expect(detectManagedRuleNames({ rules: {} })).to.deep.equal([]);
    });
  });

  describe('estimateRuleTreeComplexity', () => {
    it('sums behaviors + criteria recursively across the tree', () => {
      const tree = {
        rules: {
          behaviors: [{ name: 'a' }, { name: 'b' }], // 2
          criteria: [{ name: 'c' }], // 1
          children: [
            { behaviors: [{ name: 'd' }], criteria: [], children: [] }, // 1
            { behaviors: [], criteria: [{ name: 'e' }, { name: 'f' }] }, // 2
          ],
        },
      };
      expect(estimateRuleTreeComplexity(tree)).to.equal(6);
    });

    it('is safe on empty/missing input', () => {
      expect(estimateRuleTreeComplexity(undefined)).to.equal(0);
      expect(estimateRuleTreeComplexity({})).to.equal(0);
      expect(estimateRuleTreeComplexity({ rules: {} })).to.equal(0);
    });
  });

  describe('getManagedFetcherKey', () => {
    const treeWithKey = (key) => ({
      rules: {
        children: [{
          name: 'Optimize at Edge',
          children: [{
            name: 'Optimize at Edge Routing',
            behaviors: [
              { name: 'origin', options: {} },
              {
                name: 'modifyIncomingRequestHeader',
                options: { customHeaderName: 'x-edgeoptimize-fetcher-key', headerValue: key },
              },
            ],
          }],
        }],
      },
    });

    it('extracts the fetcher-key header value from the managed rule', () => {
      expect(getManagedFetcherKey(treeWithKey('abc123'))).to.equal('abc123');
    });

    it('returns null when there is no managed fetcher-key header', () => {
      const tree = { rules: { children: [{ name: 'Existing', behaviors: [{ name: 'origin' }] }] } };
      expect(getManagedFetcherKey(tree)).to.equal(null);
    });

    it('is safe on empty/missing input', () => {
      expect(getManagedFetcherKey(undefined)).to.equal(null);
      expect(getManagedFetcherKey({})).to.equal(null);
      expect(getManagedFetcherKey({ rules: {} })).to.equal(null);
    });

    it('distinguishes two versions minted with different keys', () => {
      expect(getManagedFetcherKey(treeWithKey('K1')))
        .to.not.equal(getManagedFetcherKey(treeWithKey('K2')));
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

    it('appends the managed wrapper as the LAST child by default and declares the cache variable', () => {
      const merged = mergeIntoTree(baseTree, cfg);
      const names = merged.rules.children.map((c) => c.name);
      // OAE origin + cacheId are last-match-wins on Akamai, so the wrapper must sit after the
      // existing delivery rules or a later sibling clobbers its origin override.
      expect(names[names.length - 1]).to.equal(cfg.ruleNames.parent);
      expect(names).to.include('Existing Rule');
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

    it('replaces a legacy managed rule name with a trailing space', () => {
      const treeTrailing = {
        rules: {
          name: 'default',
          children: [{ name: 'Existing Rule' }, { name: 'Optimize at Edge ' }],
          variables: [],
        },
      };
      const names = mergeIntoTree(treeTrailing, cfg).rules.children.map((c) => c.name);
      // The trailing-space legacy rule is gone and exactly one managed wrapper remains — matching
      // buildRuleTreePatch, so the plan preview no longer shows a phantom duplicate.
      expect(names).to.not.include('Optimize at Edge ');
      expect(names.filter((n) => n.trim() === cfg.ruleNames.parent)).to.have.length(1);
    });

    it('strips leftover flat routing/failover-test rules from the older layout', () => {
      const flatTree = {
        rules: {
          name: 'default',
          children: [
            { name: LEGACY_ROUTING_NAME, children: [] },
            { name: cfg.ruleNames.failoverTest, children: [] },
            { name: 'Existing Rule', children: [] },
          ],
          variables: [],
        },
      };
      const merged = mergeIntoTree(flatTree, cfg);
      const names = merged.rules.children.map((c) => c.name);
      expect(names).to.deep.equal(['Existing Rule', cfg.ruleNames.parent]);
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
      expect(merged.rules.variables[0].name).to.equal(cfg.cacheKeyVariable.name);
    });

    it('throws when the tree has no top-level rules object', () => {
      expect(() => mergeIntoTree({}, cfg)).to.throw("missing a top-level 'rules' object");
    });
  });

  describe('buildRuleTreePatch', () => {
    let cfg;
    beforeEach(() => {
      cfg = buildRuleConfig({ hostname: HOSTNAME, apiKey: API_KEY });
    });

    const addChildOps = (ops) => ops.filter((o) => o.op === 'add' && o.path.startsWith('/rules/children'));
    const removeOps = (ops) => ops.filter((o) => o.op === 'remove');

    it('adds the managed wrapper (no remove) and declares the cache variable when none exist', () => {
      const tree = {
        rules: { name: 'default', children: [{ name: 'Existing Rule' }], variables: [] },
      };
      const ops = buildRuleTreePatch(tree, cfg);
      expect(removeOps(ops)).to.have.length(0);
      // Default appends after the existing children (last), so the op targets `-`, not index 0.
      const add = ops.find((o) => o.op === 'add' && o.path === '/rules/children/-');
      expect(add).to.exist;
      expect(add.value.name).to.equal(cfg.ruleNames.parent);
      const varOp = ops.find((o) => o.path === '/rules/variables/-');
      expect(varOp.value.name).to.equal(cfg.cacheKeyVariable.name);
    });

    it('is idempotent for a legacy name with a trailing space (removes it by trimmed name)', () => {
      const tree = {
        rules: {
          name: 'default',
          children: [{ name: 'Existing' }, { name: 'Optimize at Edge ' }],
          variables: [{ name: cfg.cacheKeyVariable.name, value: '' }],
        },
      };
      const ops = buildRuleTreePatch(tree, cfg);
      // Trailing-space rule at index 1 is removed; no variable op (the cache-key var is present).
      expect(removeOps(ops).map((o) => o.path)).to.deep.equal(['/rules/children/1']);
      expect(ops.some((o) => o.path.startsWith('/rules/variables'))).to.equal(false);
      expect(addChildOps(ops)[0].value.name).to.equal(cfg.ruleNames.parent);
    });

    it('removes multiple managed rules highest-index-first', () => {
      const tree = {
        rules: {
          name: 'default',
          children: [
            { name: LEGACY_ROUTING_NAME },
            { name: 'Keep' },
            { name: cfg.ruleNames.parent },
            { name: cfg.ruleNames.failoverTest },
          ],
          variables: [{ name: cfg.cacheKeyVariable.name }],
        },
      };
      const ops = buildRuleTreePatch(tree, cfg);
      expect(removeOps(ops).map((o) => o.path)).to.deep.equal([
        '/rules/children/3', '/rules/children/2', '/rules/children/0',
      ]);
    });

    it('appends via `-` when insertIndex is clamped to the end', () => {
      const tree = {
        rules: {
          name: 'default',
          children: [{ name: 'A' }, { name: 'B' }],
          variables: [{ name: cfg.cacheKeyVariable.name }],
        },
      };
      const ops = buildRuleTreePatch(tree, cfg, 99);
      expect(addChildOps(ops)[0].path).to.equal('/rules/children/-');
    });

    it('creates the children array when the default rule has none', () => {
      const ops = buildRuleTreePatch({ rules: { name: 'default', variables: [] } }, cfg);
      const add = ops.find((o) => o.path === '/rules/children');
      expect(add.value).to.be.an('array').with.length(1);
      expect(add.value[0].name).to.equal(cfg.ruleNames.parent);
    });

    it('creates the variables array when the tree has none', () => {
      const ops = buildRuleTreePatch({ rules: { name: 'default', children: [] } }, cfg);
      const varOp = ops.find((o) => o.path === '/rules/variables');
      expect(varOp.value).to.be.an('array').with.length(1);
    });

    it('appends via `-` for a non-numeric insertIndex (falls back to the default)', () => {
      const tree = {
        rules: { name: 'default', children: [{ name: 'A' }], variables: [{ name: cfg.cacheKeyVariable.name }] },
      };
      const ops = buildRuleTreePatch(tree, cfg, 'nope');
      expect(addChildOps(ops)[0].path).to.equal('/rules/children/-');
    });

    it('clamps a negative insertIndex to 0', () => {
      const tree = {
        rules: { name: 'default', children: [{ name: 'A' }], variables: [{ name: cfg.cacheKeyVariable.name }] },
      };
      const ops = buildRuleTreePatch(tree, cfg, -5);
      expect(addChildOps(ops)[0].path).to.equal('/rules/children/0');
    });

    it('appends via `-` into a present-but-empty children array', () => {
      const tree = {
        rules: { name: 'default', children: [], variables: [{ name: cfg.cacheKeyVariable.name }] },
      };
      const ops = buildRuleTreePatch(tree, cfg);
      expect(addChildOps(ops)[0].path).to.equal('/rules/children/-');
    });

    it('throws when the tree has no top-level rules object', () => {
      expect(() => buildRuleTreePatch({}, cfg)).to.throw("missing a top-level 'rules' object");
    });
  });

  describe('branch coverage — edge configs', () => {
    const base = () => buildRuleConfig({ hostname: HOSTNAME, apiKey: API_KEY });

    it('converts an empty-string file extension to EMPTY_STRING (on the wrapper)', () => {
      const cfg = base();
      cfg.match.fileExtensions = ['html', ''];
      const rule = buildParentRule(cfg);
      expect(findCriterion(rule, 'fileExtension').options.values).to.include('EMPTY_STRING');
    });

    it('omits the hostname criterion when hostnames are absent (on the wrapper)', () => {
      const cfg = base();
      delete cfg.match.hostnames;
      const rule = buildParentRule(cfg);
      expect(findCriterion(rule, 'hostname')).to.equal(undefined);
    });

    it('tolerates a config without removeIncomingResponseHeaders', () => {
      const cfg = base();
      delete cfg.removeIncomingResponseHeaders;
      const rule = buildRoutingEdgeRule(cfg);
      expect(rule.behaviors.some((b) => b.name === 'modifyIncomingResponseHeader')).to.equal(false);
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

    it('appends the wrapper last for a non-numeric insertIndex (falls back to the default)', () => {
      const cfg = base();
      const tree = { rules: { name: 'default', children: [{ name: 'A' }], variables: [] } };
      const merged = mergeIntoTree(tree, cfg, 'nope');
      const names = merged.rules.children.map((c) => c.name);
      expect(names[names.length - 1]).to.equal(cfg.ruleNames.parent);
    });
  });

  describe('redactSecrets', () => {
    it('redacts both the api-key and fetcher-key header values, leaving other behaviors untouched, without mutating input', () => {
      const cfg = buildRuleConfig({ hostname: HOSTNAME, apiKey: API_KEY, fetcherKey: 'fk-secret-xyz' });
      const merged = mergeIntoTree(
        { rules: { name: 'default', children: [], variables: [] } },
        cfg,
      );
      const redacted = redactSecrets(merged);
      const s = JSON.stringify(redacted);
      expect(s).to.not.contain(API_KEY);
      expect(s).to.not.contain('fk-secret-xyz');
      expect(s).to.contain('***');
      // origin/config headers are preserved
      expect(s).to.contain('live.edgeoptimize.net');
      // input tree is untouched (deep clone)
      expect(JSON.stringify(merged)).to.contain(API_KEY);
      expect(JSON.stringify(merged)).to.contain('fk-secret-xyz');
    });

    it('tolerates trees with null behaviors, missing options, and no rules', () => {
      const tree = {
        rules: {
          name: 'default',
          behaviors: [
            null,
            { name: 'origin' },
            {
              name: 'modifyIncomingRequestHeader',
              options: { customHeaderName: 'x-edgeoptimize-api-key', headerValue: 'secret' },
            },
            {
              name: 'modifyIncomingRequestHeader',
              options: { customHeaderName: 'x-edgeoptimize-fetcher-key', headerValue: 'fk-secret' },
            },
          ],
          children: [{ name: 'child', behaviors: [] }],
        },
      };
      const redacted = redactSecrets(tree);
      const byHeader = (name) => redacted.rules.behaviors.find(
        (b) => b && b.options && b.options.customHeaderName === name,
      );
      expect(byHeader('x-edgeoptimize-api-key').options.headerValue).to.equal('***');
      expect(byHeader('x-edgeoptimize-fetcher-key').options.headerValue).to.equal('***');
      // a tree without a rules root is returned unchanged
      expect(redactSecrets({})).to.deep.equal({});
    });
  });

  describe('redactPapiErrors', () => {
    const KEY = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

    it('returns null/undefined unchanged', () => {
      expect(redactPapiErrors(null)).to.equal(null);
      expect(redactPapiErrors(undefined)).to.equal(undefined);
    });

    it('redacts an explicitly-known secret value from a string detail', () => {
      const detail = `origin header set to ${KEY} rejected`;
      expect(redactPapiErrors(detail, [KEY])).to.equal('origin header set to *** rejected');
    });

    it('redacts a 64-hex minted key with no explicit secret hint', () => {
      expect(redactPapiErrors(`value ${KEY}`, [])).to.equal('value ***');
    });

    it('redacts a value following a secret header name', () => {
      const detail = 'behavior modifyOutgoingRequestHeader x-edgeoptimize-api-key: sk-live-9f2b bad';
      expect(redactPapiErrors(detail, [])).to.contain('x-edgeoptimize-api-key: ***');
      expect(redactPapiErrors(detail, [])).to.not.contain('sk-live-9f2b');
    });

    it('scrubs secrets inside an errors array, preserving shape', () => {
      const errors = [{ type: 'x', detail: `set ${KEY} here`, errorLocation: '#/rules' }];
      const out = redactPapiErrors(errors, [KEY]);
      expect(out).to.be.an('array').with.length(1);
      expect(out[0].detail).to.equal('set *** here');
      expect(out[0].errorLocation).to.equal('#/rules');
    });

    it('bounds a large errors array to the max entries', () => {
      const errors = Array.from({ length: 40 }, (_, i) => ({ detail: `e${i}` }));
      expect(redactPapiErrors(errors, [], 25)).to.have.length(25);
    });

    it('ignores short/non-string extra secrets', () => {
      expect(redactPapiErrors('a=1', ['a', 123, null])).to.equal('a=1');
    });
  });
});
