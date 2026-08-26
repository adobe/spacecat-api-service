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
 * Ported from the `brand24` repo's `src/lib/similar-topics.ts` `findSharedThemes` —
 * same keyword-overlap algorithm, adapted to Semrush's own topic field names (`topic`
 * instead of `topic_name`; no `description` field, so only the topic name itself is
 * tokenized). A "theme" is a significant keyword present in at least one topic of
 * EVERY compared brand (here always exactly 2: Lovesac + one competitor, called
 * per-competitor rather than all-four-at-once, so a real overlap between Lovesac and
 * ANY one competitor surfaces even when the others don't share it).
 */

// Common English function words plus AI-topic-summary filler that never makes a useful
// cross-brand theme on its own.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'about', 'various', 'their', 'they', 'this',
  'that', 'are', 'was', 'were', 'have', 'has', 'had', 'including', 'across', 'often',
  'other', 'than', 'more', 'most', 'some', 'such', 'into', 'out', 'over', 'per',
  'via', 'how', 'what', 'when', 'where', 'who', 'which', 'its', 'discussions',
  'discussion', 'mentions', 'mention', 'content', 'posts', 'post', 'social', 'media',
  'references', 'reference', 'general', 'personal', 'commentary', 'coverage',
  'reviews', 'review', 'opinions', 'opinion', 'brand', 'brands', 'deals', 'prices',
  'pricing', 'listings',
]);

const MIN_LEN = 3;

function tokenize(text) {
  if (!text) {
    return [];
  }
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length >= MIN_LEN && !STOPWORDS.has(w));
}

/**
 * @param {{brand: string, topics: object[]}[]} brands - exactly the brands to intersect; a
 *   keyword theme must appear in a topic *name* of every one of them.
 * @returns {{keywords: string[], matches: {brand: string, topic: object}[], totalVolume: number}[]}
 *   Sorted by totalVolume descending.
 */
export function findSharedThemes(brands) {
  const n = brands.length;
  if (n === 0) {
    return [];
  }

  // Brand-name words become extra stopwords (e.g. "lovesac", "west", "elm") so a
  // competitor's own name mentioned in a topic doesn't masquerade as a shared theme.
  const brandWords = new Set();
  for (const b of brands) {
    for (const w of tokenize(b.brand)) {
      brandWords.add(w);
    }
  }
  const keep = (w) => !brandWords.has(w);
  const tokensOf = (topic) => tokenize(topic.topic).filter(keep);

  // keyword -> (brand name -> topics carrying it)
  const kw = new Map();
  for (const b of brands) {
    for (const topic of b.topics) {
      for (const token of new Set(tokensOf(topic))) {
        let perBrand = kw.get(token);
        if (!perBrand) {
          perBrand = new Map();
          kw.set(token, perBrand);
        }
        let hits = perBrand.get(b.brand);
        if (!hits) {
          hits = [];
          perBrand.set(b.brand, hits);
        }
        hits.push(topic);
      }
    }
  }

  const themes = [];
  for (const [keyword, perBrand] of kw) {
    // A theme requires the keyword present in every compared brand.
    if (perBrand.size === n) {
      // Representative topic per brand: highest topic_volume among topics carrying the keyword.
      const matches = brands.map((b) => {
        const hits = perBrand.get(b.brand);
        const topic = [...hits].sort((x, y) => (y.topic_volume ?? 0) - (x.topic_volume ?? 0))[0];
        return { brand: b.brand, topic };
      });
      const totalVolume = matches.reduce((sum, m) => sum + (m.topic.topic_volume ?? 0), 0);
      themes.push({ keywords: [keyword], matches, totalVolume });
    }
  }

  // Merge themes whose representative topics are identical across all brands.
  const merged = new Map();
  for (const theme of themes) {
    const sig = theme.matches.map((m) => m.topic.topic_id ?? m.topic.topic).join(' | ');
    const existing = merged.get(sig);
    if (existing) {
      existing.keywords.push(...theme.keywords);
    } else {
      merged.set(sig, { ...theme, keywords: [...theme.keywords] });
    }
  }

  const result = [...merged.values()];
  for (const theme of result) {
    theme.keywords.sort((a, b) => a.localeCompare(b));
  }
  result.sort((a, b) => b.totalVolume - a.totalVolume);
  return result;
}
