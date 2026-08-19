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
 * Web search via Tavily for the Market Discovery feature (POC). Ported from
 * brand_audit's `lib/search.js` — same primary/backup key fallback so a
 * quota exhaustion on one key doesn't stop the flow. Reads secrets from
 * `env`, never `process.env` directly.
 */

const MIN_SCORE = 0.4;

async function tavilyAttempt(apiKey, query, maxResults, options) {
  const body = {
    api_key: apiKey,
    query,
    max_results: maxResults,
    search_depth: 'advanced',
  };
  if (Array.isArray(options.includeDomains) && options.includeDomains.length) {
    body.include_domains = options.includeDomains;
  }

  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { error: { status: res.status, message: text } };
    }

    const data = await res.json();
    const raw = data.results;
    if (!raw?.length) {
      return {
        ok: true, empty: true, sources: [], context: '',
      };
    }

    const filtered = raw.filter((r) => typeof r.score !== 'number' || r.score >= MIN_SCORE);
    const results = filtered.length ? filtered : raw;

    return {
      ok: true,
      empty: false,
      context: results.map((r, i) => `[Source ${i + 1}] ${r.title}\nURL: ${r.url}\n${r.content}`).join('\n\n'),
      sources: results.map((r) => ({
        url: r.url,
        title: r.title,
        score: typeof r.score === 'number' ? r.score : null,
      })).filter((s) => !!s.url),
    };
  } catch (e) {
    return { error: { status: 0, message: e.message } };
  }
}

export async function webSearch(env, query, maxResults = 5, options = {}) {
  const primaryKey = env?.TAVILY_API_KEY;
  const backupKey = env?.TAVILY_API_KEY_BACKUP;

  if (!primaryKey && !backupKey) {
    return null;
  }

  if (primaryKey) {
    const r = await tavilyAttempt(primaryKey, query, maxResults, options);
    if (r.ok) {
      if (r.empty) {
        return null;
      }
      return { context: r.context, sources: r.sources };
    }
    // eslint-disable-next-line no-console
    console.warn(`Tavily primary failed (${r.error.status}): ${r.error.message?.slice(0, 200) || ''}`);
  }

  if (backupKey) {
    const r = await tavilyAttempt(backupKey, query, maxResults, options);
    if (r.ok) {
      if (r.empty) {
        return null;
      }
      return { context: r.context, sources: r.sources };
    }
    // eslint-disable-next-line no-console
    console.warn(`Tavily backup failed (${r.error.status}): ${r.error.message?.slice(0, 200) || ''}`);
  }

  return null;
}
