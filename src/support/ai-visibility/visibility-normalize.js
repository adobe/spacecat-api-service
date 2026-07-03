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

/* eslint-disable max-statements-per-line -- normalization helpers */

function coerceGapPromptsListTotal(value) {
  if (typeof value === 'number' && Number.isFinite(value)) { return Math.trunc(value); }
  if (typeof value === 'string') {
    const t = value.trim().replace(/,/g, '');
    if (t === '') { return undefined; }
    if (/[a-z]/i.test(t) && !/^[-+]?\d*\.?\d+e[-+]?\d+$/i.test(t)) { return undefined; }
    const n = t.includes('.') ? Number.parseFloat(t) : Number(t);
    return Number.isFinite(n) ? Math.trunc(n) : undefined;
  }
  return undefined;
}

function extractGapPromptsResponseTotal(body) {
  const topLevelKeys = ['total', 'total_count', 'totalCount', 'row_count', 'rowCount'];
  for (const k of topLevelKeys) {
    const n = coerceGapPromptsListTotal(body[k]);
    if (n !== undefined) { return n; }
  }
  const nested = [body.meta, body.pagination, body.page];
  for (const block of nested) {
    if (block != null && typeof block === 'object' && !Array.isArray(block)) {
      for (const k of topLevelKeys) {
        const n = coerceGapPromptsListTotal(block[k]);
        if (n !== undefined) { return n; }
      }
    }
  }
  return undefined;
}

function numN(v) {
  if (v == null || v === '') { return 0; }
  if (typeof v === 'string') {
    const t = v.replace(/,/g, '').trim();
    const n = Number(t);
    return Number.isFinite(n) ? n : 0;
  }
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function normalizeGapPromptsBody(body) {
  const data = Array.isArray(body.data) ? body.data : [];
  const offsetRaw = body.offset;
  const limitRaw = body.limit;
  let offset;
  if (typeof offsetRaw === 'number' && !Number.isNaN(offsetRaw)) {
    offset = offsetRaw;
  } else if (Number.isFinite(Number(offsetRaw))) {
    offset = Number(offsetRaw);
  } else {
    offset = 0;
  }
  let limit;
  if (typeof limitRaw === 'number' && !Number.isNaN(limitRaw)) {
    limit = limitRaw;
  } else if (limitRaw != null && limitRaw !== '' && Number.isFinite(Number(limitRaw))) {
    limit = Number(limitRaw);
  } else {
    limit = data.length;
  }
  const extracted = extractGapPromptsResponseTotal(body);
  let total = extracted !== undefined ? extracted : offset + data.length;
  const floor = offset + data.length;
  if (total < floor) { total = floor; }
  return {
    ...body, data, offset, limit, total,
  };
}

function nonEmptyTrimmedString(v) {
  if (typeof v === 'string') { return v.trim(); }
  if (v == null) { return ''; }
  if (typeof v === 'number' && Number.isFinite(v)) { return String(v).trim(); }
  return '';
}

function extractSourceDomainExamplePrompt(s) {
  const candidates = [
    s.promptExample, s.prompt_example, s.example_prompt, s.examplePrompt,
    s.sample_prompt, s.samplePrompt, s.example_prompt_text, s.examplePromptText,
  ];
  for (const v of candidates) {
    const str = nonEmptyTrimmedString(v);
    if (str) { return str; }
  }
  const ex = s.example;
  if (ex != null && typeof ex === 'object' && !Array.isArray(ex)) {
    for (const v of [ex.prompt, ex.text, ex.example_prompt, ex.examplePrompt]) {
      const str = nonEmptyTrimmedString(v);
      if (str) { return str; }
    }
  }
  return '';
}

function normalizeSourceDomainRow(raw) {
  const sourcesCount = numN(raw.sourcesCount ?? raw.sources_count);
  const mentions = numN(raw.mentions ?? raw.overallMentions ?? raw.overall_mentions);
  const otRaw = raw.organicTraffic ?? raw.organic_traffic;
  const hasUpstreamOrganic = otRaw !== undefined
    && otRaw !== null
    && otRaw !== ''
    && !(typeof otRaw === 'number' && !Number.isFinite(otRaw));
  const pe = extractSourceDomainExamplePrompt(raw);
  const row = {
    sourceDomain: String(raw.sourceDomain ?? raw.source_domain ?? raw.domain ?? '').trim(),
    sourcesCount,
    mentions,
  };
  row.organicTraffic = hasUpstreamOrganic ? numN(otRaw) : 0;
  if (pe) { row.promptExample = pe; }
  return row;
}

function normalizeSourceDomainsBody(body) {
  const data = Array.isArray(body.data)
    ? body.data.map((item) => (item != null && typeof item === 'object' && !Array.isArray(item)
      ? normalizeSourceDomainRow(item) : item))
    : [];
  return { ...body, data };
}

export function normalizeVisibilityV1SuccessfulBody(relPath, body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) { return body; }
  if ('error' in body) { return body; }
  if (relPath === '/competitors/gap-prompts') { return normalizeGapPromptsBody(body); }
  if (relPath === '/topics/research/source-domains') { return normalizeSourceDomainsBody(body); }
  return body;
}
