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
 *
 * The routing rule is split into two tiers (Routing Edge + Routing Parent) keyed on the requestType
 * CLIENT_REQ criterion, so the parent-tier re-evaluation cannot self-fail the api-key loop guard.
 *
 * Failover model: a single `x-edgeoptimize-edge-routed` marker is injected at the edge and PERSISTS
 * across every parent tier (never stripped on the forward path), so multi-hop requests reach Edge
 * Optimize at any tiered-distribution depth. The marker is removed only on the failover recreation
 * — which Akamai re-enters at the edge as a CLIENT_REQ already carrying the injected api-key — by a
 * "Cleanup" rule scoped to `CLIENT_REQ AND api-key EXISTS`. That recreation-only strip breaks the
 * failover loop without dropping the marker on normal forward hops (the old parent-strip broke
 * multi-hop). Cleanup and Routing Edge are mutually exclusive (api-key EXISTS vs DOES_NOT_EXIST).
 */

// Edge-tier guard: the api-key header the "Routing Edge" rule injects. On the client-facing edge
// pass it doesn't exist yet (Routing Edge matches and injects it); on any re-evaluation where it is
// already present, Routing Edge no longer matches. Combined with the requestType CLIENT_REQ
// criterion this cleanly separates the edge pass from the parent/recreated pass.
const LOOP_GUARD_HEADER = 'x-edgeoptimize-api-key';

// Worker-callback loop guard. The Edge Optimize worker sets this header when it fetches
// the original
// page back from the customer's CDN; the wrapper rule requires it to be ABSENT so those callbacks
// are NOT re-routed into Optimize at Edge (which would loop). The failover-test rule keys on its
// absence too.
const FAILOVER_MARKER_HEADER = 'x-edgeoptimize-request';

// Internal tier marker. "Routing Edge" sets it (value `true`) on the client-facing pass; "Routing
// Parent" matches on it to recognise the request as one this rule set forwarded through Akamai's
// parent tier (tiered distribution / SureRoute), and a child rule strips it before the origin fetch
// so it never reaches Edge Optimize. Namespaced with the other x-edgeoptimize-* headers, vendor-
// neutral (the CLIENT_REQ design is CDN-agnostic).
const EDGE_ROUTED_MARKER_HEADER = 'x-edgeoptimize-edge-routed';

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
    parent: 'ABV - Optimize at Edge',
    cleanup: 'EdgeOptimize Failover - Cleanup',
    routingEdge: 'Routing Edge',
    routingParent: 'Routing Parent',
    failoverTest: 'EdgeOptimize Failover - Test Header',
  },
});

// Managed rule names from earlier layouts, cleaned up (removed/replaced) on re-onboard so upgrading
// a property from the old single-routing-rule design to the two-tier design leaves no orphans.
const LEGACY_MANAGED_RULE_NAMES = Object.freeze(['Optimize at Edge', 'Optimize at Edge Routing']);

const MANAGED_COMMENT_ROUTING = 'Managed by Adobe Brand Visibility (Optimize at Edge). Routes '
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
    // Wildcard each value (*GPTBot* etc.) so it matches real-world agent strings like
    // "Mozilla/5.0 ... GPTBot/1.2", not only an exact "GPTBot". matchWildcard treats a value with
    // no '*' as an exact match, which would miss almost every real bot request.
    values: userAgents.map((ua) => (String(ua).includes('*') ? ua : `*${ua}*`)),
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

// action = ADD | MODIFY | DELETE. PAPI keys the value/name option on the action:
//  - ADD    -> standardAddHeaderName + headerValue
//  - MODIFY -> standardModifyHeaderName + newHeaderValue (replaces the header, no duplicate)
//  - DELETE -> standardDeleteHeaderName (no value)
// Managed request headers use MODIFY so re-processing at the parent tier overwrites rather than
// appends (avoidDuplicateHeaders); the failover-test response header uses ADD.
const behaviorModifyHeader = (name, action, header, value) => {
  const options = { action, customHeaderName: header };
  if (action === 'ADD') {
    options.standardAddHeaderName = 'OTHER';
    options.headerValue = value;
    options.avoidDuplicateHeaders = false;
  } else if (action === 'MODIFY') {
    options.standardModifyHeaderName = 'OTHER';
    options.newHeaderValue = value;
    options.avoidDuplicateHeaders = true;
  } else {
    options.standardDeleteHeaderName = 'OTHER';
  }
  return { name, options };
};

const behaviorModifyIncomingRequestHeader = (header, value) => behaviorModifyHeader('modifyIncomingRequestHeader', 'MODIFY', header, value);
const behaviorModifyOutgoingRequestHeader = (header, value) => behaviorModifyHeader('modifyOutgoingRequestHeader', 'MODIFY', header, value);
const behaviorModifyOutgoingResponseHeader = (header, value) => behaviorModifyHeader('modifyOutgoingResponseHeader', 'ADD', header, value);

// Strip an incoming REQUEST header before it reaches origin (e.g. the internal edge-routed marker).
const behaviorRemoveIncomingRequestHeader = (header) => behaviorModifyHeader('modifyIncomingRequestHeader', 'DELETE', header);

// "Modify Incoming Response Headers" -> Remove, for headers returned by origin that shouldn't
// pass through as-is (e.g. Age).
const behaviorRemoveIncomingResponseHeader = (header) => behaviorModifyHeader('modifyIncomingResponseHeader', 'DELETE', header);

// "Cache ID Modification" -> Include a user-defined variable. Without this, setVariable only
// computes the value; it isn't actually folded into the cache key until cacheId references it.
const behaviorCacheId = (variableName) => ({
  name: 'cacheId',
  options: { rule: 'INCLUDE_VARIABLE', variableName },
});

// "Caching Rules" -> Honor origin Cache-Control and Expires (the doc's step-4 config). Cache ID
// Modification requires a Caching behavior in scope. Added to the OAE rule ONLY when the property's
// DEFAULT rule has none (see cfg.addCaching): if the default already provides one, adding it here
// overrides the property's HTML no-store and makes the optimized path cacheable — serving a stale
// passthrough copy to bots.
const behaviorCaching = () => ({
  name: 'caching',
  options: {
    behavior: 'CACHE_CONTROL_AND_EXPIRES',
    mustRevalidate: false,
    // Fallback TTL used ONLY when the origin response omits Cache-Control/Expires (the doc's
    // Honor-origin config). AI-bot responses normally carry the worker's no-store, so this is a
    // safety net, not the common path — bounded to 1 day to avoid indefinitely caching a bad reply.
    defaultTtl: '1d',
    honorPrivate: false,
    honorMustRevalidate: false,
    enhancedRfcSupport: false,
    cacheControlDirectives: '',
  },
});

// Presence-check request-header criterion (EXISTS / DOES_NOT_EXIST): PAPI ignores value/match flags
// for those, and including them wouldn't match what PAPI itself emits.
const criterionRequestHeader = (header, matchOperator) => ({
  name: 'requestHeader',
  options: { headerName: header, matchOperator },
});

// Value-match request-header criterion (IS_ONE_OF a list of literal values). Used by "Routing
// Parent" to match the internal edge-routed marker header == "true".
const criterionRequestHeaderValue = (header, values) => ({
  name: 'requestHeader',
  options: {
    headerName: header,
    matchOperator: 'IS_ONE_OF',
    values: [...values],
    matchCaseSensitiveValue: true,
    matchWildcardName: false,
    matchWildcardValue: false,
  },
});

// Akamai "Request Type" criterion. CLIENT_REQ is the initial client-facing request at the edge;
// IS_NOT CLIENT_REQ is a parent-tier / internally-recreated request (tiered distribution,
// SureRoute,
// site failover). This is the native, Advanced-Metadata-free way to tell the edge pass from the
// parent pass — the crux of the two-tier routing split.
const criterionRequestType = (matchOperator) => ({
  name: 'requestType',
  options: { matchOperator, value: 'CLIENT_REQ' },
});

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
 * Sibling rule of the two routing rules ("Site Failover Behavior"), evaluated for both.
 * On a 4xx/5xx from
 * live.edgeoptimize.net or an origin timeout, fail over to the property's normal origin via the
 * alternate-hostname mechanism — standard GA behavior, no Advanced Metadata access needed.
 * @param {object} cfg
 * @returns {object}
 */
export function buildSiteFailoverRule(cfg) {
  return {
    name: 'Site Failover Behavior',
    criteria: [criterionMatchResponseCode(400, 599), criterionOriginTimeout()],
    criteriaMustSatisfy: 'any',
    behaviors: [behaviorFailActionAlternateHostname(cfg.failover.alternateHostname)],
    children: [],
    comments: 'Managed by Adobe Brand Visibility (Optimize at Edge). On origin failure, fails over '
      + "to the property's normal origin so the end user still gets a response.",
  };
}

/**
 * Behaviors common to BOTH routing rules (Routing Edge and Routing Parent): origin + SSL, the cache
 * key variable, the outgoing X-Forwarded-Host, the Age response-header strip, conditional caching,
 * and cacheId. `extraIncomingRequestHeaders` lets the edge rule inject the managed request headers
 * (api-key/config/url/fetcher-key) and the tier marker; the parent rule passes none (those headers
 * were already injected at the edge and persist across the parent tier).
 * @param {object} cfg
 * @param {Array<[string, string]>} [extraIncomingRequestHeaders]
 * @returns {object[]}
 */
function buildCommonRoutingBehaviors(cfg, extraIncomingRequestHeaders = []) {
  const behaviors = [
    behaviorOrigin(cfg.origin.hostname, cfg.origin.matchSan),
    behaviorSetVariable(cfg.cacheKeyVariable.name, cfg.cacheKeyVariable.value),
  ];
  extraIncomingRequestHeaders.forEach(([header, value]) => {
    behaviors.push(behaviorModifyIncomingRequestHeader(header, value));
  });
  Object.entries(cfg.outgoingRequestHeaders).forEach(([header, value]) => {
    behaviors.push(behaviorModifyOutgoingRequestHeader(header, value));
  });
  (cfg.removeIncomingResponseHeaders || []).forEach((header) => {
    behaviors.push(behaviorRemoveIncomingResponseHeader(header));
  });
  // Caching goes BEFORE cacheId. Only add it when the property's default rule has no Caching of its
  // own (cfg.addCaching) — cacheId needs a Caching behavior in scope, but adding one when the
  // default already provides it overrides the property's HTML no-store and breaks bot delivery.
  if (cfg.addCaching) {
    behaviors.push(behaviorCaching());
  }
  behaviors.push(behaviorCacheId(cfg.cacheKeyVariable.name));
  return behaviors;
}

/**
 * "Routing Edge": the client-facing pass. `requestType IS CLIENT_REQ` AND the api-key header is
 * absent (it hasn't been injected yet). Injects the managed request headers + the internal
 * `x-edgeoptimize-edge-routed` marker, and fails over on origin trouble.
 * @param {object} cfg
 * @returns {object}
 */
export function buildRoutingEdgeRule(cfg) {
  const extraHeaders = [
    ...Object.entries(cfg.incomingRequestHeaders),
    [EDGE_ROUTED_MARKER_HEADER, 'true'],
  ];
  if (cfg.wafBypass?.enabled) {
    extraHeaders.push([cfg.wafBypass.headerName, cfg.wafBypass.value]);
  }
  return {
    name: cfg.ruleNames.routingEdge,
    criteria: [
      criterionRequestType('IS'),
      // Edge-pass guard: on the client-facing request the api-key header isn't set yet.
      criterionRequestHeader(LOOP_GUARD_HEADER, 'DOES_NOT_EXIST'),
    ],
    criteriaMustSatisfy: 'all',
    behaviors: buildCommonRoutingBehaviors(cfg, extraHeaders),
    children: [],
    comments: MANAGED_COMMENT_ROUTING,
  };
}

/**
 * "Routing Parent": the parent-tier / internally-recreated pass (`requestType IS_NOT CLIENT_REQ`)
 * that carries the `x-edgeoptimize-edge-routed=true` marker the edge rule set. Re-applies the
 * origin/cache behaviors (they don't persist across the tier) and fails over on origin trouble.
 * Does NOT re-inject the credential headers — those were set at the edge and persist.
 *
 * The marker is intentionally NOT stripped here: it must PERSIST across every parent tier so that
 * multi-hop requests (edge -> parent -> parent -> ... -> origin) keep matching this rule and reach
 * Edge Optimize at any tiered-distribution depth. Stripping it at the parent (the old design) broke
 * multi-hop by dropping the marker at the first parent. The marker is removed only on the failover
 * recreation, by buildFailoverCleanupRule.
 * @param {object} cfg
 * @returns {object}
 */
export function buildRoutingParentRule(cfg) {
  return {
    name: cfg.ruleNames.routingParent,
    criteria: [
      criterionRequestType('IS_NOT'),
      criterionRequestHeaderValue(EDGE_ROUTED_MARKER_HEADER, ['true']),
    ],
    criteriaMustSatisfy: 'all',
    behaviors: buildCommonRoutingBehaviors(cfg),
    children: [],
    comments: MANAGED_COMMENT_ROUTING,
  };
}

/**
 * "EdgeOptimize Failover - Cleanup": strips the internal `x-edgeoptimize-edge-routed` marker from
 * the FAILOVER RECREATION so the parent tier will not re-route it back to Edge Optimize (which
 * would loop). Scoped to `requestType IS CLIENT_REQ AND x-edgeoptimize-api-key EXISTS`: the api-key
 * header is injected at the edge and PERSISTS into Akamai's failover recreate, so it is present
 * ONLY on the recreation — a fresh client request arrives without it. This edge-level,
 * recreation-only strip lets the marker persist across parent tiers (fixing multi-hop) while still
 * breaking the failover loop. It never fires on the same request as "Routing Edge" (which requires
 * the api-key ABSENT), so this marker delete and the marker injection there are mutually exclusive.
 * @param {object} cfg
 * @returns {object}
 */
export function buildFailoverCleanupRule(cfg) {
  return {
    name: cfg.ruleNames.cleanup,
    criteria: [
      criterionRequestType('IS'),
      criterionRequestHeader(LOOP_GUARD_HEADER, 'EXISTS'),
    ],
    criteriaMustSatisfy: 'all',
    behaviors: [behaviorRemoveIncomingRequestHeader(EDGE_ROUTED_MARKER_HEADER)],
    children: [],
    comments: 'Managed by Adobe Brand Visibility (Optimize at Edge). On the failover recreation '
      + '(a CLIENT_REQ that already carries the api-key), strips the internal edge-routed marker so '
      + 'the parent tier will not re-route it back to Edge Optimize — breaks the failover loop.',
  };
}

/**
 * The sibling "EdgeOptimize Failover - Test Header" rule. Must be a SIBLING of the routing rule
 * (same hierarchy level) so it is evaluated on the failover-recreated request.
 *
 * Detection is XML-free / no Advanced Metadata: the routing rule injects the
 * `x-edgeoptimize-api-key` request header on the first pass and it PERSISTS into Akamai's internal
 * failover recreate, whereas the advanced fail-action2 marker (`x-edgeoptimize-request`) is not
 * used. So "api-key header EXISTS AND the failover marker DOES_NOT_EXIST" identifies the
 * recreated request, and we surface it as the `x-edgeoptimize-fo` response header.
 * @param {object} cfg
 * @returns {object}
 */
export function buildFailoverTestRule(cfg) {
  return {
    name: cfg.ruleNames.failoverTest,
    criteria: [
      criterionRequestHeader(LOOP_GUARD_HEADER, 'EXISTS'),
      criterionRequestHeader(FAILOVER_MARKER_HEADER, 'DOES_NOT_EXIST'),
    ],
    criteriaMustSatisfy: 'all',
    behaviors: [behaviorModifyOutgoingResponseHeader('x-edgeoptimize-fo', 'true')],
    children: [],
    comments: 'Managed by Adobe Brand Visibility (Optimize at Edge). Surfaces failover as the '
      + 'x-edgeoptimize-fo response header, detected without advanced metadata.',
  };
}

/**
 * Wrapper rule "Optimize at Edge" grouping the two routing rules and the failover-test sibling. It
 * carries the SHARED gating criteria (hostname + AI-bot user agents + HTML/extensionless + the
 * worker-callback loop guard); the CLIENT_REQ / marker split lives on the child rules. Hoisting the
 * common match here means it is evaluated once and each child only adds what distinguishes it.
 * @param {object} cfg
 * @returns {object}
 */
export function buildParentRule(cfg) {
  const criteria = [];
  const hostnames = cfg.match.hostnames || [];
  if (hostnames.length > 0) {
    criteria.push(criterionHostname(hostnames));
  }
  criteria.push(
    criterionUserAgent(cfg.match.userAgents),
    criterionFileExtension(cfg.match.fileExtensions),
    // Worker-callback loop guard: when Edge Optimize fetches the original page back from the
    // customer CDN it sets x-edgeoptimize-request; requiring its ABSENCE keeps those callbacks out
    // of the routing rules (otherwise they'd loop).
    criterionRequestHeader(FAILOVER_MARKER_HEADER, 'DOES_NOT_EXIST'),
  );
  return {
    name: cfg.ruleNames.parent,
    criteria,
    criteriaMustSatisfy: 'all',
    behaviors: [],
    children: [
      // Cleanup runs first (top-down): on the failover recreation it strips the edge-routed marker
      // before Routing Edge/Parent are evaluated, so the recreation is not re-routed back to EO.
      buildFailoverCleanupRule(cfg),
      buildRoutingEdgeRule(cfg),
      buildRoutingParentRule(cfg),
      buildSiteFailoverRule(cfg),
      buildFailoverTestRule(cfg),
    ],
    comments: 'Managed by Adobe Brand Visibility (Optimize at Edge). Routes AI-bot HTML traffic to '
      + 'live.edgeoptimize.net via a two-tier (edge/parent) split. A single edge-routed marker '
      + 'persists across parent tiers (multi-hop safe) and is stripped only on the failover '
      + 'recreation by the Cleanup rule; native per-rule site failover.',
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

// The PMUSER_* variable declaration the managed rules depend on. Shared by mergeIntoTree (PUT path)
// and buildRuleTreePatch (PATCH path) so both emit an identical declaration.
function managedCacheKeyVariable(varName) {
  return {
    name: varName,
    value: '',
    description: 'Edge Optimize cache key (managed by Adobe Brand Visibility)',
    hidden: false,
    sensitive: false,
  };
}

// PMUSER_* variables must be declared in the rule tree's `variables` list. Mutates the given
// variables array in place (the caller owns a freshly-cloned tree), returning it for convenience.
function ensureVariableDeclared(variables, variable) {
  if (variables.some((v) => v?.name === variable.name)) {
    return variables;
  }
  variables.push(variable);
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
 * 0 = before everything, length = after everything. The default (no/blank/garbage index) is
 * AFTER everything: the wrapper's `origin` + `cacheId` are last-match-wins on Akamai, so it must
 * sit below the stock delivery rules (Offload origin, Increase availability, …) — otherwise a
 * later sibling clobbers the OAE origin override and cache isolation and bots never get routed.
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
  ensureVariableDeclared(root.variables, managedCacheKeyVariable(cfg.cacheKeyVariable.name));

  const managedNames = new Set(
    // eslint-disable-next-line no-use-before-define
    [...managedRuleNames(cfg), ...LEGACY_MANAGED_RULE_NAMES].map((name) => name.trim()),
  );
  // Match by TRIMMED name so a legacy `"Optimize at Edge "` (trailing space) is replaced, not left
  // as a duplicate — keeps this preview in step with buildRuleTreePatch (which also trims).
  const children = (root.children || []).filter((c) => !managedNames.has((c?.name ?? '').trim()));

  const n = Math.trunc(Number(insertIndex));
  // Default to LAST (children.length): only a finite, in-range index moves the wrapper earlier; a
  // missing/blank/garbage value (the wizard sends none) appends after all existing children so the
  // OAE origin + cacheId win on Akamai (siblings evaluate top-down, last match wins). The
  // controller already rejects malformed values with a 400 before reaching here.
  const idx = Number.isFinite(n) ? Math.max(0, Math.min(n, children.length)) : children.length;
  root.children = [...children.slice(0, idx), buildParentRule(cfg), ...children.slice(idx)];
  return tree;
}

/**
 * Names of the managed rules for a config, so callers can compute a before/after child-rule diff.
 * @param {object} cfg
 * @returns {string[]}
 */
export function managedRuleNames(cfg) {
  // The rules this deploy ADDS at the top level (surfaced to the review UI as "rules to add"):
  // the wrapper plus the failover-test rule. The nested routing rules live inside the wrapper and
  // their generic names must not match a customer's own top-level rules, so they are not listed.
  // Legacy names (older layouts) are NOT included here; they are only removed during cleanup (see
  // mergeIntoTree / buildRuleTreePatch), never "added", so listing them would wrongly show them
  // as pending additions.
  return [cfg.ruleNames.parent, cfg.ruleNames.failoverTest];
}

/**
 * The full hierarchy of rules this deploy adds (the wrapper and everything nested inside it), as a
 * {name, children} tree — for the review UI to show what the property will look like. Names only,
 * no behaviors, so it carries no secrets.
 * @param {object} cfg
 * @returns {{name: string, children: object[]}}
 */
export function managedRuleTree(cfg) {
  const toNode = (rule) => ({ name: rule.name, children: (rule.children || []).map(toNode) });
  return toNode(buildParentRule(cfg));
}

/**
 * Detects which managed "Optimize at Edge" rules are already present at the TOP LEVEL of a rule
 * tree, by trimmed name. Used by the deploy-status endpoint to answer "did the OAE rule actually
 * land in this version?" by re-reading live Akamai state — the source of truth when a deploy's own
 * HTTP response was lost to a CDN timeout. Matches both the current wrapped layout (only the parent
 * `"Optimize at Edge"` sits at top level, with routing/failover-test nested inside it) and the
 * older flat layout (routing/failover-test at top level), and tolerates a legacy trailing space.
 * Uses the frozen EDGE_OPTIMIZE_DEFAULTS names — no cfg needed, since a status check has no
 * hostname/apiKey to build one from.
 * @param {object} ruleTree - a PAPI rule tree ({ rules: {...} })
 * @returns {string[]} the managed rule names found at top level (deduped); empty if none
 */
export function detectManagedRuleNames(ruleTree) {
  // Only names that can appear at TOP LEVEL: the wrapper (current layout), plus the failover-test
  // and legacy routing names from the oldest flat layout. The two-tier routing rules are nested
  // inside the wrapper and never surface here.
  const managed = new Set([
    EDGE_OPTIMIZE_DEFAULTS.ruleNames.parent,
    EDGE_OPTIMIZE_DEFAULTS.ruleNames.failoverTest,
    ...LEGACY_MANAGED_RULE_NAMES,
  ]);
  const children = ruleTree?.rules?.children || [];
  const found = children
    .map((c) => (c?.name ?? '').trim())
    .filter((name) => managed.has(name));
  return [...new Set(found)];
}

/**
 * Builds a JSON Patch (RFC 6902) that inserts the managed "Optimize at Edge" wrapper rule (and its
 * PMUSER cache-key variable) into an existing rule tree WITHOUT re-serialising any existing rule or
 * behaviour.
 *
 * Why a patch instead of mergeIntoTree + full-tree PUT: a GET→merge→PUT round-trip re-stores PAPI's
 * GET-expanded projection of behaviours we never touch (e.g. an origin on "Use Platform Settings"
 * comes back with expanded SSL/TLS fields), which validateRules then rejects as incompatible. A
 * server-side PATCH applies only these deltas to the STORED tree, so untouched behaviours are never
 * re-serialised by us and that whole class of false rejection disappears.
 *
 * Idempotent: any existing managed rule is removed first — matched by TRIMMED name, so a legacy
 * `"Optimize at Edge "` (trailing space) is cleaned up too — then re-added, never duplicated.
 *
 * `insertIndex` positions the wrapper among the *non-managed* children (0 = before everything =
 * default, length = after everything), matching mergeIntoTree.
 *
 * @param {object} ruleTree - the property's current rule-tree document ({ rules: {...}, ... })
 * @param {object} cfg
 * @param {number} [insertIndex]
 * @returns {Array<object>} JSON Patch operations (empty-safe; always adds the wrapper)
 */
export function buildRuleTreePatch(ruleTree, cfg, insertIndex) {
  const root = ruleTree?.rules;
  if (root === null || typeof root !== 'object') {
    throw new Error("Rule tree is missing a top-level 'rules' object.");
  }

  const ops = [];

  // 1. Insert the managed wrapper as a child of the default rule, first removing any existing
  //    managed rules so a re-run replaces rather than duplicates.
  if (!Array.isArray(root.children)) {
    // No children array at all — create it containing just the managed wrapper.
    ops.push({ op: 'add', path: '/rules/children', value: [buildParentRule(cfg)] });
  } else {
    const { children } = root;
    const managed = new Set(
      [...managedRuleNames(cfg), ...LEGACY_MANAGED_RULE_NAMES].map((name) => name.trim()),
    );
    // Match by TRIMMED name so a legacy `"Optimize at Edge "` (trailing space) is cleaned up too.
    const isManaged = (child) => managed.has((child?.name ?? '').trim());

    // Remove existing managed rules highest index first, so the earlier indices we still need stay
    // valid as the array shrinks (a JSON Patch remove shifts later elements down).
    const managedIndexes = [];
    children.forEach((child, i) => {
      if (isManaged(child)) {
        managedIndexes.push(i);
      }
    });
    managedIndexes
      .sort((a, b) => b - a)
      .forEach((i) => ops.push({ op: 'remove', path: `/rules/children/${i}` }));

    // After those removals run, the array is exactly the non-managed children in their original
    // order, so clamp insertIndex against that length (mirrors mergeIntoTree). Default (no/blank/
    // garbage index) appends last so the OAE origin + cacheId win (Akamai is last-match-wins).
    const nonManagedCount = children.length - managedIndexes.length;
    const n = Math.trunc(Number(insertIndex));
    const idx = Number.isFinite(n) ? Math.max(0, Math.min(n, nonManagedCount)) : nonManagedCount;
    ops.push({
      op: 'add',
      // `-` appends; a numeric index inserts before it. Append when idx lands at/after the end.
      path: idx >= nonManagedCount ? '/rules/children/-' : `/rules/children/${idx}`,
      value: buildParentRule(cfg),
    });
  }

  // 2. Declare the PMUSER cache-key variable if the tree doesn't already have it. `add` to a
  //    missing `/rules/variables` would fail, so create the array when absent.
  const varName = cfg.cacheKeyVariable.name;
  if (!Array.isArray(root.variables)) {
    ops.push({ op: 'add', path: '/rules/variables', value: [managedCacheKeyVariable(varName)] });
  } else if (!root.variables.some((v) => v?.name === varName)) {
    ops.push({ op: 'add', path: '/rules/variables/-', value: managedCacheKeyVariable(varName) });
  }

  return ops;
}

// Request headers carrying confidential values that must never be logged or returned to clients:
// the site's LLMO API key and the customer's fetcher key (the Bot Manager allowlist secret). Both
// are injected by buildRuleConfig and redacted from any rule tree that leaves the server.
const API_KEY_HEADER = 'x-edgeoptimize-api-key';
const FETCHER_KEY_HEADER = 'x-edgeoptimize-fetcher-key';
const SECRET_HEADERS = new Set([API_KEY_HEADER, FETCHER_KEY_HEADER]);
const REDACTED = '***';

/**
 * Returns a deep clone of a rule tree with the injected secret header values (the LLMO API key and
 * the fetcher key) redacted, for previews/diffs that leave the server (e.g. the plan response).
 * Walks every rule's behaviors and replaces the value of any modifyIncomingRequestHeader that sets
 * a secret header.
 * @param {object} tree - a PAPI rule tree ({ rules: {...} })
 * @returns {object} a redacted deep clone
 */
export function redactSecrets(tree) {
  const clone = structuredClone(tree);
  const walk = (rule) => {
    if (!rule || typeof rule !== 'object') {
      return;
    }
    (rule.behaviors || []).forEach((b) => {
      if (b?.name === 'modifyIncomingRequestHeader' && SECRET_HEADERS.has(b.options?.customHeaderName)) {
        // Redact whichever value field the action uses: MODIFY -> newHeaderValue,
        // ADD -> headerValue.
        // Mutating a deep clone we own, not the caller's tree.
        /* eslint-disable no-param-reassign */
        if ('newHeaderValue' in b.options) {
          b.options.newHeaderValue = REDACTED;
        }
        if ('headerValue' in b.options) {
          b.options.headerValue = REDACTED;
        }
        /* eslint-enable no-param-reassign */
      }
    });
    (rule.children || []).forEach(walk);
  };
  walk(clone.rules);
  return clone;
}

// PAPI validation errors/details echo back the rules we sent, so they can carry the injected
// x-edgeoptimize-api-key / x-edgeoptimize-fetcher-key header values — scrub those before returning
// them to a client. Redacts any explicitly-known secret value, any value following a secret header
// name, and any 32-byte hex token (the shape of a minted fetcher key).
const SECRET_HEADER_VALUE_RE = /(x-edgeoptimize-(?:api|fetcher)-key["'\s]*[:=]["'\s]*)([^"'\s,}\]]+)/gi;
const MINTED_FETCHER_KEY_RE = /\b[0-9a-f]{64}\b/gi;

function scrubSecretText(text, extraSecrets) {
  let out = String(text);
  extraSecrets.forEach((v) => {
    if (typeof v === 'string' && v.length >= 4) {
      out = out.split(v).join(REDACTED);
    }
  });
  return out.replace(SECRET_HEADER_VALUE_RE, `$1${REDACTED}`).replace(MINTED_FETCHER_KEY_RE, REDACTED);
}

/**
 * Redacts injected secrets from PAPI errors before they leave the server. Accepts the errors array
 * (deploy's validateRules result) or the raw detail string (activation's 400 body) and returns the
 * same shape — arrays bounded to `max` entries. Pass any secret values known at the call site (e.g.
 * the deploy's apiKey/fetcherKey); header-name and hex-token patterns catch the rest.
 * @param {Array|string|null} errors
 * @param {string[]} [extraSecrets] - explicit secret values to redact
 * @param {number} [max] - max array entries to keep
 * @returns {Array|string|null} the redacted errors, same shape as the input
 */
export function redactPapiErrors(errors, extraSecrets = [], max = 25) {
  if (errors == null) {
    return errors;
  }
  if (typeof errors === 'string') {
    return scrubSecretText(errors, extraSecrets);
  }
  const bounded = Array.isArray(errors) ? errors.slice(0, max) : errors;
  return JSON.parse(scrubSecretText(JSON.stringify(bounded), extraSecrets));
}

/**
 * Returns the fetcher-key value (the x-edgeoptimize-fetcher-key incoming-request header the managed
 * routing rule injects) from a rule tree, or null if absent. A fresh fetcher key is minted on every
 * deploy, so it's a per-deploy fingerprint: deploy-status compares it between a version and its
 * base to tell "this deploy's fresh write landed" (keys differ) from "the version is just an
 * unwritten clone inheriting the previous onboard's rule" (keys identical).
 * NEVER return this value to a client — it's a secret (redactSecrets scrubs it from responses); it
 * is only compared server-side. Walks the whole tree for the first matching header.
 * @param {object} tree - a PAPI rule tree ({ rules: {...} })
 * @returns {string|null} the fetcher-key header value, or null when the tree has no managed rule
 */
export function getManagedFetcherKey(tree) {
  let found = null;
  const walk = (rule) => {
    if (found !== null || !rule || typeof rule !== 'object') {
      return;
    }
    (rule.behaviors || []).forEach((b) => {
      // MODIFY carries the value in newHeaderValue, ADD in headerValue.
      const value = b?.options?.newHeaderValue ?? b?.options?.headerValue;
      if (found === null
        && b?.name === 'modifyIncomingRequestHeader'
        && b.options?.customHeaderName === FETCHER_KEY_HEADER
        && typeof value === 'string') {
        found = value;
      }
    });
    (rule.children || []).forEach(walk);
  };
  walk(tree?.rules);
  return found;
}

/**
 * Estimates how expensive Akamai's own PAPI `validateRules` pass will be for a rule tree, by
 * summing behaviors + criteria (match conditions) across every rule, recursively. This mirrors the
 * exact metric PAPI itself enforces a hard ceiling on — a property reports "Current usage is X out
 * of 3000 available" for this same behaviors+matches total when exceeded (confirmed against a real
 * Akamai property while testing a large-property fix). Used as a fast, pre-flight proxy for "will
 * this take too long to validate" before ever attempting the slow validate/write call — Akamai's
 * own processing time scales with this same total, and unlike raw rule count it's tied to a real,
 * already-observed Akamai constraint rather than an arbitrary number.
 * @param {object} ruleTree - a PAPI rule tree ({ rules: {...} })
 * @returns {number} total behaviors + criteria across every rule in the tree
 */
export function estimateRuleTreeComplexity(ruleTree) {
  let total = 0;
  const walk = (rule) => {
    if (!rule || typeof rule !== 'object') {
      return;
    }
    total += (rule.behaviors || []).length;
    total += (rule.criteria || []).length;
    (rule.children || []).forEach(walk);
  };
  walk(ruleTree?.rules);
  return total;
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
 * @param {boolean} [params.addCaching=false] - add a Caching behavior to the OAE rule. Set this to
 *   `!defaultRuleHasCaching(ruleTree)`: only add Caching when the property's default rule has none
 *   (so Cache ID Modification validates). When the default already caches, leave it OFF so the OAE
 *   rule inherits the property's HTML no-store instead of overriding it.
 * @param {string} [params.originHostname] - the Edge Optimize worker host to route AI-bot traffic
 *   to. Defaults to the prod worker; pass `env.EDGE_OPTIMIZE_EDGE_DOMAIN` so a dev/stage deployment
 *   routes to dev/stage.edgeoptimize.net. The `matchSan` (`*.edgeoptimize.net`) covers all three.
 * @param {string} [params.fetcherKey] - the fetcher key (a secret minted server-side per deploy).
 *   When provided, it's set as the `x-edgeoptimize-fetcher-key` incoming request header so the
 *   customer can allowlist it (with the `AdobeEdgeOptimize/1.0` user agent) in their Akamai Bot
 *   Manager/WAF. The controller always supplies one now; the guard below stays defensive.
 * @returns {object} config consumable by buildParentRule/mergeIntoTree
 */
export function buildRuleConfig({
  hostname, apiKey, addCaching = false, originHostname, fetcherKey,
}) {
  const d = EDGE_OPTIMIZE_DEFAULTS;
  const resolvedOriginHost = (typeof originHostname === 'string' && originHostname.trim())
    ? originHostname.trim()
    : d.origin.hostname;
  const trimmedFetcherKey = typeof fetcherKey === 'string' ? fetcherKey.trim() : '';
  return {
    match: {
      userAgents: [...d.userAgents],
      fileExtensions: [...d.fileExtensions],
      hostnames: [hostname],
    },
    origin: { ...d.origin, hostname: resolvedOriginHost },
    cacheKeyVariable: { ...d.cacheKeyVariable },
    incomingRequestHeaders: {
      ...d.incomingRequestHeaders,
      'x-edgeoptimize-api-key': apiKey,
      // Add the server-minted fetcher-key header (Bot Manager allowlist). The controller always
      // supplies one now; the guard stays defensive against a missing/blank value.
      ...(trimmedFetcherKey ? { 'x-edgeoptimize-fetcher-key': trimmedFetcherKey } : {}),
    },
    outgoingRequestHeaders: { ...d.outgoingRequestHeaders },
    removeIncomingResponseHeaders: [...d.removeIncomingResponseHeaders],
    ruleNames: { ...d.ruleNames },
    failover: { alternateHostname: hostname },
    addCaching,
  };
}
