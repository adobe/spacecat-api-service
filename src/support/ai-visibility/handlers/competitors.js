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

/* eslint-disable max-statements-per-line, max-len -- AI Visibility handler surface */

import { ConnectError, Code } from '@connectrpc/connect';
import { StatsResponseSchema } from '@quazar/ai-seo-ts/ai-cr/messages_pb.js';
import {
  brandTarget, resolveCountryForCompetitorsMetrics,
  engineToLlm, parseCompetitorDomainsList,
} from '../grpc-utils.js';
import { messageToJson } from '../proto-json.js';

function mapCompetitorsStatsResponse(raw) {
  const json = messageToJson(StatsResponseSchema, raw);
  const rows = Array.isArray(json.byBrand) ? json.byBrand : [];
  return {
    byBrand: rows.map((row) => {
      const byDate = Array.isArray(row?.byDate) ? row.byDate : [];
      return {
        brand: {
          domain: row?.brand?.domain ?? '',
          name: row?.brand?.name ?? row?.brand?.domain ?? '',
        },
        byDate,
      };
    }),
  };
}

export async function handleCompetitorsMetrics(sp, clients) {
  const domain = sp.get('domain')?.trim();
  if (!domain) { return { status: 400, body: { error: 'missing_domain', message: 'domain is required' } }; }
  const compDomains = parseCompetitorDomainsList(sp);
  if (compDomains.length === 0) {
    return {
      status: 400,
      body: { error: 'missing_competitors', message: 'Set competitors=comma-separated-domains (and/or repeated competitor=)' },
    };
  }
  const country = resolveCountryForCompetitorsMetrics(sp);
  const body = { country, target: brandTarget(domain), competitors: compDomains.map(brandTarget) };
  const explicit = sp.get('gapSnapshotDate')?.trim() || sp.get('metricsSnapshotDate')?.trim();
  const dm = explicit && /^(\d{4})-(\d{2})-(\d{1,2})$/.exec(explicit);
  if (dm) {
    const d = { year: Number(dm[1]), month: Number(dm[2]), day: Number(dm[3]) };
    body.dateRange = { from: d, till: d };
  }
  const llm = engineToLlm(sp.get('engine')?.trim() || '');
  if (llm) { body.llm = llm; }
  let raw;
  try {
    raw = await clients.crMetricsClient.stats(body);
  } catch (e) {
    const msg = String(e?.message || e);
    const isNotFound = (e instanceof ConnectError && e.code === Code.NotFound)
      || /Code:\s*NotFound/i.test(msg)
      || /\bNotFound\b/i.test(msg);
    if (isNotFound) { return { status: 200, body: { byBrand: [] } }; }
    throw e;
  }
  return { status: 200, body: mapCompetitorsStatsResponse(raw) };
}
