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

// Failover marker, and the routing rule's loop guard.
//
// This header is set ONLY by the fail-action2 Advanced XML, when Akamai recreates a request that
// failed against live.edgeoptimize.net. It is never present on a fresh client request, and — this
// is the important part — it stays absent however many times the rule tree is evaluated on the way
// to origin (edge, parent tier in a tiered distribution, and so on).
//
// A header that the routing rule injects itself cannot be used for this. It is present from the
// moment the rule first matches, so any later re-evaluation of the tree sees the rule's own output
// and stops matching, sending traffic to the property's default origin instead of Edge Optimize.
//
// The Advanced XML that sets this marker CANNOT be deployed through PAPI — advanced behaviors are
// read-only and only Akamai representatives can add them. The rule set below is deployed without
// it, and the customer is told to have Akamai support add the snippet; until they do, failover is
// not functional.
const FAILOVER_MARKER_HEADER = 'x-edgeoptimize-request';
const FAILOVER_MARKER_VALUE = 'fo';

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

// MODIFY, not ADD. The routing rule matches on every Akamai server that handles the request —
// edge AND any parent server in a tiered distribution — so these behaviors execute more than once
// for the same request. ADD would append a second copy each time (e.g. a duplicated
// X-Forwarded-Host, which the edge worker rejects with a 403). MODIFY sets the value, so running it
// N times yields one
// header carrying our value, regardless of how many tiers evaluate the tree.
// avoidDuplicateHeaders is belt-and-suspenders for the same reason.
const behaviorModifyHeader = (name, header, value) => ({
  name,
  options: {
    action: 'MODIFY',
    standardModifyHeaderName: 'OTHER',
    customHeaderName: header,
    newHeaderValue: value,
    avoidDuplicateHeaders: true,
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

// Presence checks (EXISTS / DOES_NOT_EXIST) carry no value/match flags — PAPI ignores them and
// including them wouldn't match what PAPI itself emits. Value checks (IS_ONE_OF / IS_NOT_ONE_OF)
// do; the field names below mirror what PAPI emits for a value-matching requestHeader criterion.
const criterionRequestHeader = (header, matchOperator, values) => {
  const options = { headerName: header, matchOperator };
  if (matchOperator === 'IS_ONE_OF' || matchOperator === 'IS_NOT_ONE_OF') {
    options.values = [...(values || [])];
    options.matchCaseSensitiveValue = true;
    options.matchWildcardName = false;
    options.matchWildcardValue = false;
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
 * Nested child rule of the routing rule ("Site Failover Behavior"): on a 4xx/5xx from
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
    comments: 'Managed by Adobe LLM Optimizer (Optimize at Edge). On origin failure, fails over '
      + "to the property's normal origin so the end user still gets a response. "
      + 'ACTION REQUIRED: ask Akamai support to add the fail-action2 Advanced XML to this rule so '
      + 'the recreated request is tagged with x-edgeoptimize-request: fo. Advanced behaviors '
      + 'cannot be added through the API. Until it is added, failover is not functional.',
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
  // Caching goes BEFORE cacheId. Only add it when the property's default rule has no Caching of its
  // own (cfg.addCaching) — cacheId needs a Caching behavior in scope, but adding one when the
  // default already provides it overrides the property's HTML no-store and breaks bot delivery.
  if (cfg.addCaching) {
    behaviors.push(behaviorCaching());
  }
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
  // Loop guard: skip requests already tagged by the failover marker, i.e. Akamai's recreate of a
  // request that failed against Edge Optimize. See FAILOVER_MARKER_HEADER for why the marker has
  // to come from the fail-action2 XML rather than from a header this rule sets itself.
  //
  // TRUST ASSUMPTION: this keys on the mere presence of a client-suppliable header, so a client
  // that forges x-edgeoptimize-request can suppress Optimize-at-Edge routing for itself or force a
  // false x-edgeoptimize-fo. That is acceptable here: the only party harmed is the forging client
  // (it opts itself out of optimization). Revisit if this header ever gates anything
  // security-sensitive.
  criteria.push(criterionRequestHeader(FAILOVER_MARKER_HEADER, 'DOES_NOT_EXIST'));

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
 * (same hierarchy level) so it is evaluated on the failover-recreated request.
 *
 * The recreated request is identified by the failover marker that the fail-action2 Advanced XML
 * attaches to it (`x-edgeoptimize-request: fo`), and we surface it as the `x-edgeoptimize-fo`
 * response header. That XML cannot be deployed through PAPI, so this rule stays inert until an
 * Akamai representative adds the snippet to the Site Failover Behavior rule.
 * @param {object} cfg
 * @returns {object}
 */
export function buildFailoverTestRule(cfg) {
  return {
    name: cfg.ruleNames.failoverTest,
    criteria: [
      criterionRequestHeader(FAILOVER_MARKER_HEADER, 'IS_ONE_OF', [FAILOVER_MARKER_VALUE]),
    ],
    criteriaMustSatisfy: 'all',
    behaviors: [behaviorModifyOutgoingResponseHeader('x-edgeoptimize-fo', 'true')],
    children: [],
    comments: 'Managed by Adobe LLM Optimizer (Optimize at Edge). Surfaces failover as the '
      + 'x-edgeoptimize-fo response header. Requires the fail-action2 Advanced XML, which only '
      + 'Akamai support can add.',
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

// The PMUSER_* variable declaration the managed rules depend on. Shared by mergeIntoTree (PUT path)
// and buildRuleTreePatch (PATCH path) so both emit an identical declaration.
function managedCacheKeyVariable(varName) {
  return {
    name: varName,
    value: '',
    description: 'Edge Optimize cache key (managed by Adobe LLM Optimizer)',
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

  const managedNames = new Set([
    cfg.ruleNames.parent,
    cfg.ruleNames.routing,
    cfg.ruleNames.failoverTest,
  ]);
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
  return [cfg.ruleNames.parent, cfg.ruleNames.routing, cfg.ruleNames.failoverTest];
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
  const managed = new Set(Object.values(EDGE_OPTIMIZE_DEFAULTS.ruleNames));
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
    const managed = new Set(managedRuleNames(cfg).map((name) => name.trim()));
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
        // Mutating a deep clone we own, not the caller's tree. MODIFY behaviors carry the value in
        // newHeaderValue; legacy ADD behaviors (older deployed properties) carry it in headerValue.
        // Redact whichever is present so a secret never leaks regardless of which the tree uses.
        /* eslint-disable no-param-reassign */
        if (typeof b.options.newHeaderValue === 'string') {
          b.options.newHeaderValue = REDACTED;
        }
        if (typeof b.options.headerValue === 'string') {
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
      // MODIFY behaviors carry the value in newHeaderValue; legacy ADD behaviors carry it in
      // headerValue. Read whichever is present so this works against both forms.
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
