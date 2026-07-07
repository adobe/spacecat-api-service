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

/**
 * Pure, side-effect-free builders for the Akamai Property Manager (PAPI) rule-tree fragments
 * that wire a customer's property to Adobe LLM Optimizer "Optimize at Edge" (BYOCDN) routing,
 * plus an idempotent merge into an existing rule tree.
 *
 * Source of truth for the configuration:
 * https://experienceleague.adobe.com/en/docs/llm-optimizer/using/resources/optimize-at-edge/akamai-byocdn
 * PAPI rule-tree format:
 * https://techdocs.akamai.com/property-mgr/reference/rule-format
 *
 * Ported (1:1) from the edge_optimize POC's rules_builder.py. Everything here is deterministic
 * and dependency-free so it can be unit-tested and previewed offline (no Akamai credentials).
 */

// Loop guard: one of the headers the routing rule ALREADY injects via
// modifyIncomingRequestHeader (see buildRoutingRule). No real client ever sends this on its own —
// only this rule sets it. On the first pass it doesn't exist yet; on Akamai's internal failover
// retry of the SAME request it is still attached (the retry continues the same request context,
// not a fresh replay), so a DOES_NOT_EXIST check detects "is this a retry" using a header we need
// anyway — no advanced XML or dedicated marker required.
const LOOP_GUARD_HEADER = 'x-edgeoptimize-api-key';

// Marker Akamai's internal failover retry pass carries once the routing rule's origin fetch has
// failed once. Purely for the OPTIONAL sibling "Failover Test" rule's reporting; NOT used for
// loop prevention (see LOOP_GUARD_HEADER above).
const FAILOVER_MARKER_HEADER = 'x-edgeoptimize-request';
const FAILOVER_MARKER_VALUE = 'fo';

// Advanced XML injected (only when failover.enabled) so a failed origin fetch tags the request
// with the marker above, for the reporting rule.
const FAILOVER_FAIL_ACTION_XML = [
  '<forward:availability.fail-action2>',
  '  <add-header>',
  '    <status>on</status>',
  `    <name>${FAILOVER_MARKER_HEADER}</name>`,
  `    <value>${FAILOVER_MARKER_VALUE}</value>`,
  '  </add-header>',
  '</forward:availability.fail-action2>',
].join('\n');

// Stable defaults for the managed rule config. These mirror the doc 1:1 and are service-owned
// (not caller-supplied); only the per-site hostname and the LLMO API key are injected at runtime
// via buildRuleConfig.
export const EDGE_OPTIMIZE_DEFAULTS = Object.freeze({
  userAgents: [
    'AdobeEdgeOptimize-AI',
    'ChatGPT-User',
    'GPTBot',
    'OAI-SearchBot',
    'PerplexityBot',
    'Perplexity-User',
    'ClaudeBot',
    'Claude-User',
    'Claude-SearchBot',
  ],
  fileExtensions: ['html', 'EMPTY_STRING'],
  origin: {
    hostname: 'live.edgeoptimize.net',
    matchSan: '*.edgeoptimize.net',
  },
  cacheKeyVariable: {
    name: 'PMUSER_EDGE_OPTIMIZE_CACHE_KEY',
    value: 'LLMCLIENT=TRUE;X_FORWARDED_HOST={{builtin.AK_HOST}}',
  },
  incomingRequestHeaders: {
    // Value filled at runtime with the site's LLMO API key (see buildRuleConfig).
    'x-edgeoptimize-api-key': '',
    'x-edgeoptimize-config': 'LLMCLIENT=TRUE;',
    'x-edgeoptimize-url': '{{builtin.AK_URL}}',
  },
  outgoingRequestHeaders: {
    'x-forwarded-host': '{{builtin.AK_HOST}}',
  },
  removeIncomingResponseHeaders: ['Age'],
  ruleNames: {
    parent: 'Optimize at Edge',
    routing: 'Optimize at Edge Routing',
    failoverTest: 'EdgeOptimize Failover - Test Header',
  },
});

const MANAGED_COMMENT_ROUTING = 'Managed by Adobe LLM Optimizer (Optimize at Edge). Routes '
  + 'AI-bot HTML traffic to live.edgeoptimize.net.';

// ---------------------------------------------------------------------------
// Criteria / behavior builders (map 1:1 to the doc's steps)
// ---------------------------------------------------------------------------

// Scopes the routing rule to the intended site(s) — without this, a property serving multiple
// hostnames would route AI-bot traffic for ALL of them, not just the one being onboarded.
const criterionHostname = (hostnames) => ({
  name: 'hostname',
  options: { matchOperator: 'IS_ONE_OF', values: [...hostnames] },
});

const criterionUserAgent = (userAgents) => ({
  name: 'userAgent',
  options: {
    matchOperator: 'IS_ONE_OF',
    values: [...userAgents],
    matchCaseSensitive: false,
    matchWildcard: true,
  },
});

const criterionFileExtension = (extensions) => ({
  name: 'fileExtension',
  options: {
    matchOperator: 'IS_ONE_OF',
    // PAPI represents extensionless URLs with the literal "EMPTY_STRING", not an actual empty
    // string — normalize "" the same way so either form works.
    values: extensions.map((e) => (e === '' ? 'EMPTY_STRING' : e)),
    matchCaseSensitive: false,
  },
});

const behaviorOrigin = (hostname, matchSan) => ({
  name: 'origin',
  options: {
    originType: 'CUSTOMER',
    hostname,
    forwardHostHeader: 'ORIGIN_HOSTNAME',
    cacheKeyHostname: 'ORIGIN_HOSTNAME',
    compress: true,
    enableTrueClientIp: true,
    trueClientIpHeader: 'True-Client-IP',
    // If the incoming request already has a True-Client-IP header, trust and forward it as-is
    // instead of only using Akamai's own detected value — required to make origin fetches to
    // live.edgeoptimize.net succeed (confirmed on the live property).
    trueClientIpClientSetting: true,
    originSni: true,
    // "Match SAN" from the doc -> custom valid CN/SAN values. The first two are Akamai's own
    // variable tokens (literally rendered this way in PAPI JSON — confirmed against the live
    // property's rule tree).
    verificationMode: 'CUSTOM',
    customValidCnValues: ['{{Origin Hostname}}', '{{Forward Host Header}}', matchSan],
    originCertsToHonor: 'STANDARD_CERTIFICATE_AUTHORITIES',
    // Both CA sets enabled (Akamai Certificate Store + Third Party Certificate Store) —
    // confirmed against the live property; "Third Party Certificate Store" fixes origin fetches.
    standardCertificateAuthorities: ['akamai-permissive', 'THIRD_PARTY_AMAZON'],
    ports: '',
    httpPort: 80,
    httpsPort: 443,
  },
});

const behaviorSetVariable = (name, value) => ({
  name: 'setVariable',
  options: {
    variableName: name,
    valueSource: 'EXPRESSION',
    variableValue: value,
    transform: 'NONE',
  },
});

const behaviorModifyHeader = (name, header, value) => ({
  name,
  options: {
    action: 'ADD',
    standardAddHeaderName: 'OTHER',
    customHeaderName: header,
    headerValue: value,
    avoidDuplicateHeaders: false,
  },
});

const behaviorModifyIncomingRequestHeader = (header, value) => behaviorModifyHeader('modifyIncomingRequestHeader', header, value);
const behaviorModifyOutgoingRequestHeader = (header, value) => behaviorModifyHeader('modifyOutgoingRequestHeader', header, value);
const behaviorModifyOutgoingResponseHeader = (header, value) => behaviorModifyHeader('modifyOutgoingResponseHeader', header, value);

// "Modify Incoming Response Headers" -> Remove, for headers returned by origin that shouldn't
// pass through as-is (e.g. Age).
const behaviorRemoveIncomingResponseHeader = (header) => ({
  name: 'modifyIncomingResponseHeader',
  options: {
    action: 'DELETE',
    standardDeleteHeaderName: 'OTHER',
    customHeaderName: header,
  },
});

// "Cache ID Modification" -> Include a user-defined variable. Without this, setVariable only
// computes the value; it isn't actually folded into the cache key until cacheId references it.
const behaviorCacheId = (variableName) => ({
  name: 'cacheId',
  options: { rule: 'INCLUDE_VARIABLE', variableName },
});

const behaviorAdvanced = (description, xml) => ({
  name: 'advanced',
  options: { description, xml },
});

const criterionRequestHeader = (header, values = [], matchOperator = 'IS_ONE_OF') => {
  const options = { headerName: header, matchOperator };
  // EXISTS / DOES_NOT_EXIST are presence-only checks — no values or match flags apply, and
  // including them doesn't match what PAPI itself emits. Value-based operators always receive an
  // array from their callers (defaulting to [] when omitted).
  if (matchOperator === 'IS_ONE_OF' || matchOperator === 'IS_NOT_ONE_OF') {
    Object.assign(options, {
      values: [...values],
      matchCaseSensitive: false,
      matchWildcardName: false,
      matchWildcardValue: false,
    });
  }
  return { name: 'requestHeader', options };
};

const criterionMatchResponseCode = (lower, upper) => ({
  name: 'matchResponseCode',
  options: { matchOperator: 'IS_BETWEEN', lowerBound: lower, upperBound: upper },
});

const criterionOriginTimeout = () => ({
  name: 'originTimeout',
  options: { matchOperator: 'ORIGIN_TIMED_OUT' },
});

// "Site Failover" -> Use alternate hostname in this property. Standard/GA behavior — no Advanced
// Metadata access required, unlike the fail-action2 tag.
const behaviorFailActionAlternateHostname = (hostname) => ({
  name: 'failAction',
  options: {
    enabled: true,
    actionType: 'RECREATED_CO',
    contentHostname: hostname,
    contentCustomPath: false,
  },
});

// ---------------------------------------------------------------------------
// Rule builders
// ---------------------------------------------------------------------------

/**
 * The failover *tag* (used by the sibling test rule) relies on an "advanced" (raw XML metadata)
 * behavior. PAPI rejects NEW advanced behaviors from customer credentials with a 403 lock-error
 * ("Only Akamai representatives can change read-only...") unless Akamai has already provisioned
 * Advanced Metadata access for the property. Defaults to false; set config.failover.enabled=true
 * once that access is granted. The Site Failover behavior itself does NOT depend on this — it's GA.
 * @param {object} cfg
 * @returns {boolean}
 */
export function failoverEnabled(cfg) {
  return cfg.failover?.enabled === true;
}

/**
 * Nested child rule of the routing rule ("Site Failover Behavior"): on a 4xx/5xx from
 * live.edgeoptimize.net or an origin timeout, fail over to the property's normal origin via the
 * alternate-hostname mechanism — standard GA behavior, no Advanced Metadata access needed.
 * Optionally (if failoverEnabled) also tags the request via the advanced fail-action2 XML so the
 * sibling "Failover Test" rule can report it happened.
 * @param {object} cfg
 * @returns {object}
 */
export function buildSiteFailoverRule(cfg) {
  const behaviors = [behaviorFailActionAlternateHostname(cfg.failover.alternateHostname)];
  if (failoverEnabled(cfg)) {
    behaviors.push(behaviorAdvanced(
      `Edge Optimize: tag request with ${FAILOVER_MARKER_HEADER}=${FAILOVER_MARKER_VALUE} on origin failure`,
      FAILOVER_FAIL_ACTION_XML,
    ));
  }
  return {
    name: 'Site Failover Behavior',
    criteria: [criterionMatchResponseCode(400, 599), criterionOriginTimeout()],
    criteriaMustSatisfy: 'any',
    behaviors,
    children: [],
    comments: 'Managed by Adobe LLM Optimizer (Optimize at Edge). On origin failure, fails over '
      + "to the property's normal origin so the end user still gets a response.",
  };
}

/**
 * The main "Optimize at Edge Routing" rule.
 * @param {object} cfg
 * @returns {object}
 */
export function buildRoutingRule(cfg) {
  const behaviors = [
    behaviorOrigin(cfg.origin.hostname, cfg.origin.matchSan),
    behaviorSetVariable(cfg.cacheKeyVariable.name, cfg.cacheKeyVariable.value),
  ];
  Object.entries(cfg.incomingRequestHeaders).forEach(([header, value]) => {
    behaviors.push(behaviorModifyIncomingRequestHeader(header, value));
  });
  Object.entries(cfg.outgoingRequestHeaders).forEach(([header, value]) => {
    behaviors.push(behaviorModifyOutgoingRequestHeader(header, value));
  });
  (cfg.removeIncomingResponseHeaders || []).forEach((header) => {
    behaviors.push(behaviorRemoveIncomingResponseHeader(header));
  });
  behaviors.push(behaviorCacheId(cfg.cacheKeyVariable.name));

  if (cfg.wafBypass?.enabled) {
    behaviors.push(
      behaviorModifyIncomingRequestHeader(cfg.wafBypass.headerName, cfg.wafBypass.value),
    );
  }

  const criteria = [];
  const hostnames = cfg.match.hostnames || [];
  if (hostnames.length > 0) {
    criteria.push(criterionHostname(hostnames));
  }
  criteria.push(
    criterionUserAgent(cfg.match.userAgents),
    criterionFileExtension(cfg.match.fileExtensions),
  );
  // Loop guard: exclude requests that already carry one of the headers this rule injects (see
  // LOOP_GUARD_HEADER) — true for Akamai's internal failover retry of the SAME request, never
  // true for a fresh client request.
  const incomingHeaders = cfg.incomingRequestHeaders;
  const guardHeader = LOOP_GUARD_HEADER in incomingHeaders
    ? LOOP_GUARD_HEADER
    : Object.keys(incomingHeaders)[0];
  if (guardHeader) {
    criteria.push(criterionRequestHeader(guardHeader, null, 'DOES_NOT_EXIST'));
  }
  // Belt-and-suspenders: also exclude the official failover marker header, in case the advanced
  // fail-action2 tag (optional, see failoverEnabled) is active — redundant but harmless.
  criteria.push(criterionRequestHeader(FAILOVER_MARKER_HEADER, null, 'DOES_NOT_EXIST'));

  return {
    name: cfg.ruleNames.routing,
    criteria,
    criteriaMustSatisfy: 'all',
    behaviors,
    children: [buildSiteFailoverRule(cfg)],
    comments: MANAGED_COMMENT_ROUTING,
  };
}

/**
 * The sibling "EdgeOptimize Failover - Test Header" rule. Must be a SIBLING of the routing rule
 * (same hierarchy level), not nested, so it is evaluated after the routing rule's failover header
 * is set.
 * @param {object} cfg
 * @returns {object}
 */
export function buildFailoverTestRule(cfg) {
  return {
    name: cfg.ruleNames.failoverTest,
    criteria: [criterionRequestHeader(FAILOVER_MARKER_HEADER, [FAILOVER_MARKER_VALUE])],
    criteriaMustSatisfy: 'all',
    behaviors: [behaviorModifyOutgoingResponseHeader('x-edgeoptimize-fo', 'true')],
    children: [],
    comments: 'Managed by Adobe LLM Optimizer (Optimize at Edge). Surfaces failover as the '
      + 'x-edgeoptimize-fo response header.',
  };
}

/**
 * Wrapper rule grouping the routing rule and its failover-test sibling under one named parent, so
 * they show up in Property Manager as a single manageable unit. No criteria of its own (matches
 * everything) — each child still gates on its own criteria.
 * @param {object} cfg
 * @returns {object}
 */
export function buildParentRule(cfg) {
  return {
    name: cfg.ruleNames.parent,
    criteria: [],
    criteriaMustSatisfy: 'all',
    behaviors: [],
    children: [buildRoutingRule(cfg), buildFailoverTestRule(cfg)],
    comments: 'Managed by Adobe LLM Optimizer (Optimize at Edge). Groups the Optimize at Edge '
      + 'routing rule and its failover-test sibling.',
  };
}

/**
 * The managed wrapper rule (with routing + failover-test nested inside), for inspection/diffing
 * without a base tree.
 * @param {object} cfg
 * @returns {{parentRule: object}}
 */
export function buildFragments(cfg) {
  return { parentRule: buildParentRule(cfg) };
}

// ---------------------------------------------------------------------------
// Merge into an existing rule tree (idempotent)
// ---------------------------------------------------------------------------

// PMUSER_* variables must be declared in the rule tree's `variables` list. Mutates the given
// variables array in place (the caller owns a freshly-cloned tree), returning it for convenience.
function ensureVariableDeclared(variables, varName) {
  if (variables.some((v) => v?.name === varName)) {
    return variables;
  }
  variables.push({
    name: varName,
    value: '',
    description: 'Edge Optimize cache key (managed by Adobe LLM Optimizer)',
    hidden: false,
    sensitive: false,
  });
  return variables;
}

/**
 * Returns a new rule tree with a single wrapper rule (see buildParentRule) inserted as a top-level
 * child of the default rule, containing the routing rule and its failover-test sibling nested
 * inside. Re-running is idempotent: an existing rule with a managed name is replaced, not
 * duplicated — this also strips any leftover top-level routing/failover-test rules from the older
 * flat (non-wrapped) layout, so upgrading is clean.
 *
 * `insertIndex` positions the wrapper among the *existing* (non-managed) children:
 * 0 = before everything (default), length = after everything.
 *
 * @param {object} ruleTree - the property's current rule tree ({ rules: {...} })
 * @param {object} cfg
 * @param {number} [insertIndex]
 * @returns {object} a new (deep-cloned) rule tree
 */
export function mergeIntoTree(ruleTree, cfg, insertIndex) {
  const tree = structuredClone(ruleTree);
  const root = tree.rules;
  if (root === null || typeof root !== 'object') {
    throw new Error("Rule tree is missing a top-level 'rules' object.");
  }

  if (!Array.isArray(root.variables)) {
    root.variables = [];
  }
  ensureVariableDeclared(root.variables, cfg.cacheKeyVariable.name);

  const managedNames = new Set([
    cfg.ruleNames.parent,
    cfg.ruleNames.routing,
    cfg.ruleNames.failoverTest,
  ]);
  const children = (root.children || []).filter((c) => !managedNames.has(c?.name));

  const idx = insertIndex === undefined || insertIndex === null
    ? 0
    : Math.max(0, Math.min(Math.trunc(Number(insertIndex)), children.length));
  root.children = [...children.slice(0, idx), buildParentRule(cfg), ...children.slice(idx)];
  return tree;
}

/**
 * Names of the managed rules for a config, so callers can compute a before/after child-rule diff.
 * @param {object} cfg
 * @returns {string[]}
 */
export function managedRuleNames(cfg) {
  return [cfg.ruleNames.parent, cfg.ruleNames.routing, cfg.ruleNames.failoverTest];
}

// ---------------------------------------------------------------------------
// Config assembly
// ---------------------------------------------------------------------------

/**
 * Builds the full managed rule config for a site from the service-owned defaults plus the two
 * per-site runtime values: the site's hostname (scopes routing + alternate-hostname failover) and
 * the site's LLMO API key (injected as the x-edgeoptimize-api-key request header).
 *
 * @param {object} params
 * @param {string} params.hostname - the site's (normalized) hostname
 * @param {string} params.apiKey - the site's LLMO API key
 * @param {boolean} [params.enableFailoverTag=false] - opt into the advanced fail-action2 XML tag
 *   (only when Akamai has provisioned Advanced Metadata access on the property)
 * @returns {object} config consumable by buildParentRule/mergeIntoTree
 */
export function buildRuleConfig({ hostname, apiKey, enableFailoverTag = false }) {
  const d = EDGE_OPTIMIZE_DEFAULTS;
  return {
    match: {
      userAgents: [...d.userAgents],
      fileExtensions: [...d.fileExtensions],
      hostnames: [hostname],
    },
    origin: { ...d.origin },
    cacheKeyVariable: { ...d.cacheKeyVariable },
    incomingRequestHeaders: {
      ...d.incomingRequestHeaders,
      'x-edgeoptimize-api-key': apiKey,
    },
    outgoingRequestHeaders: { ...d.outgoingRequestHeaders },
    removeIncomingResponseHeaders: [...d.removeIncomingResponseHeaders],
    ruleNames: { ...d.ruleNames },
    failover: { enabled: enableFailoverTag, alternateHostname: hostname },
  };
}
