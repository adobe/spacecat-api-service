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

import { callLLM } from './llm.js';

/**
 * Asks the LLM to suggest authoritative URLs from its training knowledge,
 * complementing Tavily search with well-known review sites, Reddit threads,
 * and YouTube channels that may not clear Tavily's relevance filter. Ported
 * from brand_audit's `execute-prompts` route.
 */
export async function suggestSourcesFromLLM(env, prompt) {
  try {
    const messages = [
      {
        role: 'system',
        content: 'You are a research assistant. List 6-12 authoritative URLs that would be cited when answering '
          + "the user's question. Include a mix of: editorial review sites, Reddit threads, YouTube videos/channels, "
          + 'and forum posts. Only include URLs you are confident exist. Return ONLY a JSON array of objects with '
          + "'url' and 'title' fields, with no prose, no markdown fences, no other text. "
          + 'Example: [{"url":"https://www.example.com/review","title":"Example Review"}]',
      },
      { role: 'user', content: prompt },
    ];
    const text = await callLLM(env, { messages, options: { maxTokens: 800 } });
    if (!text) {
      return [];
    }
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) {
      return [];
    }
    const arr = JSON.parse(match[0]);
    if (!Array.isArray(arr)) {
      return [];
    }
    return arr
      .filter((s) => s && typeof s.url === 'string' && /^https?:\/\//i.test(s.url))
      .map((s) => ({ url: s.url, title: s.title || '', score: null }));
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('LLM source suggestion failed:', e.message);
    return [];
  }
}

/** Normalizes a source URL for de-duplication (drop scheme/www/query/hash/trailing slash). */
function normalizedSourceKey(url) {
  return String(url)
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?/, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');
}

/** Dedupe sources by normalized URL (drop scheme/www/query/hash/trailing slash). */
export function dedupSources(sources) {
  const seen = new Set();
  const out = [];
  for (const s of sources) {
    const key = s?.url ? normalizedSourceKey(s.url) : null;
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(s);
    }
  }
  return out;
}
