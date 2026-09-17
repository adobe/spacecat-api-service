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
 * Shared agent-type validation for LLMO controllers.
 *
 * The `agentTypes` query parameter is consumed today by the agentic-traffic
 * controller (kpis-trend, by-url) and the URL Inspector PG owned-urls
 * handler. Both surfaces forward the parsed list to the same family of
 * `p_agent_types TEXT[]` RPC parameters in mysticat-data-service, so the
 * validation lookup is shared here to keep the canonical list — and the
 * "silent drop unknown values" semantic — in one place.
 *
 * NOTE: mirrors the values stored in `agentic_traffic_weekly.agent_type`
 * (and the CASE whitelists inside the corresponding RPCs). Update both
 * sides together when introducing new agent types.
 */

/**
 * Canonical agent-type values accepted by the agentic-traffic RPC family.
 * Re-emitted to the DB as-is (the PG predicate does case-insensitive
 * matching but matches against canonical casing for legibility).
 */
export const VALID_AGENT_TYPES_CANONICAL = ['Chatbots', 'Research', 'Training bots'];

/**
 * Lowercase → canonical map used by `parseAgentTypes` for case-insensitive
 * lookup of incoming tokens.
 */
export const VALID_AGENT_TYPES_LOOKUP = new Map(
  VALID_AGENT_TYPES_CANONICAL.map((value) => [value.toLowerCase(), value]),
);

/**
 * Parse the additive `agentTypes` inclusion list into an array of canonical
 * agent_type values (`Chatbots`, `Research`, `Training bots`) or null.
 *
 * Accepts either a comma-separated string (`"Chatbots,Research"`) or an array
 * passed as-is by the caller. Whitespace is trimmed, casing is normalised
 * case-insensitively, and unknown values are silently dropped — same defence
 * as `successRate`. An empty resulting list collapses to null so the RPC
 * receives `p_agent_types=NULL` and returns the unfiltered baseline.
 */
export function parseAgentTypes(raw) {
  if (raw === undefined || raw === null) {
    return null;
  }
  const tokens = Array.isArray(raw)
    ? raw
    : String(raw).split(',');
  const canonical = tokens.reduce((acc, token) => {
    if (typeof token !== 'string') {
      return acc;
    }
    const key = token.trim().toLowerCase();
    if (!key) {
      return acc;
    }
    const value = VALID_AGENT_TYPES_LOOKUP.get(key);
    if (value && !acc.includes(value)) {
      acc.push(value);
    }
    return acc;
  }, []);
  return canonical.length > 0 ? canonical : null;
}
