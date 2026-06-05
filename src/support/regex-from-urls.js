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
 * Derives a URL classification regex from a small set of sample URLs.
 *
 * The ladder runs in order — first strategy whose regex matches every input wins:
 *   1. Common prefix   — longest shared path prefix, snapped to a segment boundary.
 *   2. Universal token — single whole-segment keyword present in every URL.
 *   3. Disjoint cover  — one token per URL joined with anchored alternation.
 *   4. Literal fallback — escaped, alternated full paths.
 *
 * Each strategy returns `{ regex, method, evidence }`.
 */

// Minimum segment length to qualify as a token. 3 so short but real category
// segments ("mac", "faq", "art", "tax") tokenize instead of dropping to literal
// fallback; the segment-boundary anchor (/|\.|$) keeps short tokens precise.
// (2-char segments stay out: they're indistinguishable from locale codes.)
const MIN_TOKEN_LEN = 3;

// API-side guard: keeps DB rows small and bounds backtracking risk.
const MAX_REGEX_LEN = 512;

const CASE_INSENSITIVE_PREFIX = '(?i)';

// Start of a path-anchored rule, tolerant of how the matched `url` is stored:
// an optional leading slash and an optional locale segment (with or without its
// own leading slash). Matches all of: "/products", "products", "/en/products",
// "en/products". CDN-log url columns are inconsistent about the leading slash
// across sites, and existing auto-rules are anchored to the no-slash form — so
// rules must work either way without a global url normalization.
const PATH_START = '^/?(?:[a-z]{2}(?:-[a-z]{2,4})?/)?';

// Start of a token: string-start or a slash, so "/docs", "en/docs", and a
// first-segment "docs/…" all match.
const SEG_START = '(?:^|/)';

// Locale-segment pattern: /en, /en-us/, /de_de/, etc. (just the locale, nothing more).
const LOCALE_ONLY_RE = /^\/[a-z]{2}([-_][a-z]{2})?\/?\s*$/i;

/** True when a bare segment token is locale-only (e.g. "en", "en-us"). */
function isLocaleToken(token) {
  return LOCALE_ONLY_RE.test(`/${token}`);
}

// A leading locale segment to strip before deriving (/en, /en-gb, /zh-hans …),
// only when followed by another segment so a real 2-letter segment at the end
// is left alone.
const LEADING_LOCALE_RE = /^\/[a-z]{2}(-[a-z]{2,4})?(?=\/)/i;

/** Drop a leading locale segment so the derived rule generalises across locales. */
function stripLeadingLocale(path) {
  return path.replace(LEADING_LOCALE_RE, '');
}

// Trailing server-page / markup extension (e.g. /loyalty/redeem.mi, /foo.aspx).
// Stripped before deriving so it neither becomes a token nor breaks the
// common-prefix segment-boundary snap; the (/|\.|$) boundary still matches the
// extension at runtime, so the rule keeps matching the real .mi/.html URLs.
const PAGE_EXT_RE = /\.(?:mi|aspx?|jspx?|do|cfm|php|s?html?|phtml)$/i;

/** Drop a trailing server-page extension so it doesn't pollute derivation. */
function stripPageExtension(path) {
  return path.replace(PAGE_EXT_RE, '');
}

/**
 * Extract the URL path from a URL string. Falls back to the raw input
 * if URL parsing fails so customers can pass bare paths ("/products/foo").
 */
function extractPath(raw) {
  if (raw.startsWith('/')) {
    return raw;
  }
  try {
    const u = new URL(raw);
    return u.pathname || '/';
  } catch {
    return raw;
  }
}

/** Escape a string for safe inclusion inside a regex literal. */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile-test a `(?i)`-prefixed regex against the JS engine (i flag).
 */
function isCompilable(regex) {
  try {
    // eslint-disable-next-line no-new
    new RegExp(regex.replace(/^\(\?i\)/, ''), 'i');
    return true;
  } catch {
    return false;
  }
}

/**
 * Test whether a (?i)-prefixed regex matches every path.
 */
function matchesAll(regex, paths) {
  // Ladder only calls matchesAll after isCompilable passes, so the source is safe.
  const compiled = new RegExp(regex.replace(/^\(\?i\)/, ''), 'i');
  return paths.every((p) => compiled.test(p));
}

/**
 * Strategy 1: Longest common prefix, snapped to a path-segment boundary.
 * Rejects a locale-only prefix (e.g. /en-us/) to prevent over-broad rules.
 */
function tryCommonPrefix(paths) {
  // Case-insensitive char comparison; keep the casing from the first input.
  // regexFromUrls guarantees a non-empty paths array before any strategy runs.
  let prefix = paths[0];
  for (let i = 1; i < paths.length; i += 1) {
    const p = paths[i];
    let j = 0;
    while (
      j < prefix.length
      && j < p.length
      && prefix[j].toLowerCase() === p[j].toLowerCase()
    ) {
      j += 1;
    }
    prefix = prefix.slice(0, j);
    if (prefix.length === 0) {
      break;
    }
  }

  // Require non-trivial prefix (bare "/" is not useful).
  if (prefix.length <= 1) {
    return null;
  }

  // Snap to segment boundary: keep only if every input has end-of-string or
  // "/" immediately after the prefix; otherwise trim back to the last "/".
  const onBoundary = paths.every((p) => {
    const next = p[prefix.length];
    return next === undefined || next === '/';
  });
  if (!onBoundary) {
    const lastSlash = prefix.lastIndexOf('/');
    if (lastSlash <= 0) {
      return null; // no segment boundary to trim to
    }
    prefix = prefix.slice(0, lastSlash + 1); // keep trailing slash
  }

  // Reject a locale-only prefix (e.g. /en-us/, /de/) — matches entire site.
  if (LOCALE_ONLY_RE.test(prefix)) {
    return null;
  }

  // A prefix that ends mid-segment (no trailing "/") must be bounded so it
  // can't match a longer sibling: "^/products/foo" would otherwise also match
  // "/products/foobar". A "/"-terminated prefix is already segment-bounded.
  const boundary = prefix.endsWith('/') ? '' : '(/|\\.|$)';
  const prefixNoLead = prefix.replace(/^\//, '');
  const regex = `${CASE_INSENSITIVE_PREFIX}${PATH_START}${escapeRegex(prefixNoLead)}${boundary}`;
  return {
    regex,
    method: 'common-prefix',
    core: prefixNoLead,
    evidence: `All ${paths.length} URLs share prefix ${prefix}`,
  };
}

/**
 * Split a path into whole slash-delimited segments (lowercased, extension-stripped).
 * Only segments >= MIN_TOKEN_LEN qualify.
 * "/products/photoshop.html" → ["products", "photoshop"]
 */
function segmentsOf(path) {
  const segs = path.toLowerCase().split('/').filter(Boolean);
  return segs
    // Strip a trailing file extension only on the LAST segment, and only when
    // it looks like a real extension (".html", ".json"). A dotted middle
    // segment ("node.js") or a version ("v1.2") must keep its dot.
    .map((seg, i) => (i === segs.length - 1 ? seg.replace(/\.[a-z0-9]{1,5}$/, '') : seg))
    .filter((seg) => seg.length >= MIN_TOKEN_LEN);
}

/**
 * Strategy 2: A single token that appears as a complete segment in every URL.
 * Emits `(?i)/<token>(/|\\.|$)` to avoid substring matches.
 */
function tryUniversalToken(paths) {
  const segSets = paths.map(segmentsOf);
  const candidates = segSets[0];

  // Prefer the longest universal token. Drop locale-only tokens (e.g. "en-us")
  // so the common-prefix locale guard can't be sidestepped here.
  const universal = candidates
    .filter((t) => segSets.every((s) => s.includes(t)))
    .filter((t) => !isLocaleToken(t))
    .sort((a, b) => b.length - a.length);

  if (universal.length === 0) {
    return null;
  }
  const token = universal[0];
  const regex = `${CASE_INSENSITIVE_PREFIX}${SEG_START}${escapeRegex(token)}(/|\\.|$)`;
  return {
    regex,
    method: 'universal-token',
    core: token,
    evidence: `All ${paths.length} URLs contain the segment "${token}"`,
  };
}

/**
 * Strategy 3: One distinct segment-token per URL, joined with anchored alternation.
 * Emits `(?i)/(token1|token2)(/|\\.|$)` to prevent substring collisions.
 */
function tryDisjointCover(paths) {
  const tokens = [];
  for (const path of paths) {
    // Exclude locale-only tokens so a per-URL pick can't yield a whole-locale rule.
    const segs = segmentsOf(path).filter((t) => !isLocaleToken(t));
    if (segs.length === 0) {
      return null;
    }
    // Add the most distinctive (longest) segment — product/category names like
    // "customer-journey-analytics" beat short generic containers ("docs",
    // "browse"), so the rule captures meaning instead of the container. Skip if a
    // token we already picked is a whole segment of this path: its `(/|\.|$)`
    // boundary already matches here (e.g. "travel-insurance" covers
    // "/travel-insurance/uk-..."), so a redundant alternative would be wasteful.
    if (!segs.some((s) => tokens.includes(s))) {
      const best = segs.slice().sort((a, b) => b.length - a.length)[0];
      tokens.push(best);
    }
  }
  const alts = tokens.map(escapeRegex).join('|');
  const regex = `${CASE_INSENSITIVE_PREFIX}${SEG_START}(${alts})(/|\\.|$)`;
  return {
    regex,
    method: 'disjoint-cover',
    evidence: `Per-URL keywords: ${tokens.join(', ')}`,
  };
}

/**
 * Strategy 4: Escape every path and alternate verbatim. Never generalises.
 */
function literalFallback(paths) {
  // Drop the leading slash before escaping so PATH_START (which tolerates an
  // optional leading slash + locale) governs the start, matching the path with
  // or without a leading slash and with or without a locale prefix.
  const escaped = paths.map((p) => escapeRegex(p.replace(/^\//, '')));
  const regex = `${CASE_INSENSITIVE_PREFIX}${PATH_START}(${escaped.join('|')})(/|\\.|$)`;
  return {
    regex,
    method: 'literal-fallback',
    evidence: `Exact match against ${paths.length} URL(s)`,
  };
}

/**
 * Compute a regex matching every URL using the 4-strategy ladder.
 *
 * @param {string[]} urls - Sample URLs (or paths) supplied by the customer.
 * @returns {{regex: string, method: string, evidence: string}}
 * @throws {Error} - When urls is missing/empty/non-array, when entries are
 *   non-string, or when no strategy can produce a compilable regex under MAX_REGEX_LEN.
 */
export function regexFromUrls(urls) {
  if (!Array.isArray(urls) || urls.length === 0) {
    throw new Error('urls must be a non-empty array');
  }
  if (urls.some((u) => typeof u !== 'string' || u.trim().length === 0)) {
    throw new Error('every url must be a non-empty string');
  }

  const paths = urls
    .map((u) => stripPageExtension(extractPath(u.trim())))
    .filter((p) => p.length > 0);
  /* c8 ignore next 3 -- non-empty strings always yield a path */
  if (paths.length === 0) {
    throw new Error('urls did not yield any extractable paths');
  }

  // Derive from locale-stripped paths so the rule generalises across locales.
  // Anchored rules still tolerate a leading locale (OPTIONAL_LOCALE_PREFIX);
  // literal fallback runs on the original paths so the guaranteed-match escape
  // hatch always matches verbatim.
  const generalPaths = paths.map(stripLeadingLocale);

  // common-prefix usually wins, but when it collapses to a short generic
  // container (e.g. "/solutions/") while a universal token reaches deeper
  // ("/value-based-care"), the deeper token is more specific — try it first.
  const cp = tryCommonPrefix(generalPaths);
  const ut = tryUniversalToken(generalPaths);
  const preferToken = cp && ut && ut.core.length > cp.core.length;

  const strategies = [
    () => (preferToken ? ut : cp),
    () => (preferToken ? cp : ut),
    () => tryDisjointCover(generalPaths),
    () => literalFallback(paths),
  ];

  for (const strategy of strategies) {
    const result = strategy();
    const usable = result
      && result.regex.length <= MAX_REGEX_LEN
      && isCompilable(result.regex)
      && matchesAll(result.regex, paths);
    if (usable) {
      return result;
    }
  }

  // Reachable only when every strategy (incl. literal fallback) exceeds MAX_REGEX_LEN.
  throw new Error('Failed to derive a regex from the supplied URLs');
}

/**
 * Validate a customer-supplied regex string.
 *
 * @param {string} regex - Customer-supplied regex (with or without `(?i)`).
 * @returns {string} - The validated regex (unchanged).
 * @throws {Error} - On empty input, oversized regex, or compile failure.
 */
export function validateUserRegex(regex) {
  if (typeof regex !== 'string' || regex.length === 0) {
    throw new Error('regex must be a non-empty string');
  }
  // Normalize to case-insensitive so a pasted rule matches the same way derived
  // rules do (every derived regex carries the (?i) prefix); otherwise validation
  // (which forces the 'i' flag) would lie about case-sensitive runtime behavior.
  // Power users who need case-sensitivity can opt out with an inline (?-i).
  const normalized = regex.startsWith(CASE_INSENSITIVE_PREFIX)
    ? regex
    : `${CASE_INSENSITIVE_PREFIX}${regex}`;
  if (normalized.length > MAX_REGEX_LEN) {
    throw new Error(`regex exceeds ${MAX_REGEX_LEN} characters`);
  }
  if (!isCompilable(normalized)) {
    throw new Error('regex is not a valid regular expression');
  }
  return normalized;
}

export const REGEX_FROM_URLS_INTERNALS = {
  MIN_TOKEN_LEN,
  MAX_REGEX_LEN,
};
