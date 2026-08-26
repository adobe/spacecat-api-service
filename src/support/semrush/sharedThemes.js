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
 * Keyword-grouped market themes — the same "similar topics" idea as the `brand24` repo's
 * `src/lib/similar-topics.ts` `findSharedThemes`: tokenize topic names, drop stopwords and
 * every compared brand's own name/product words, and treat a significant keyword shared
 * across brands as a "theme" carrying one representative topic per brand. Adapted here to
 * Semrush's field names (`topic`/`topic_volume`; no `description`) and to the market-topics
 * framing: a theme must include the BRAND plus at least one competitor (so it's a topic
 * Lovesac AND the market talk about), rather than brand24's stricter "present in every
 * brand" rule. Keywords that resolve to the same representative topics are merged into one
 * theme (so "sectional" + "sofa" collapse when they point at the same topics), exactly as
 * brand24 merges them.
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
 * @param {{name: string, topics: object[]}} brand - the anchor brand; every theme must include it.
 * @param {{name: string, topics: object[]}[]} competitors
 * @returns {{keywords: string[], members: {brand: string, topic: object}[],
 *   brandCount: number, peakVolume: number, totalMentions: number}[]} sorted by peakVolume desc.
 *   `peakVolume` is the MAX of the members' topic volumes (topic demand is brand-independent —
 *   summing would triple-count a topic several brands share); `totalMentions` is the SUM (mentions
 *   are per-brand, so the total is the theme's whole-market mention count).
 */
export function groupMarketThemes(brand, competitors) {
  const allBrands = [brand, ...competitors];

  // Every brand's own name words become extra stopwords (e.g. "lovesac", "west", "elm")
  // so a competitor's own name in a topic doesn't masquerade as a shared theme.
  const brandWords = new Set();
  for (const b of allBrands) {
    for (const w of tokenize(b.name)) {
      brandWords.add(w);
    }
  }
  const keep = (w) => !brandWords.has(w);
  const tokensOf = (topic) => tokenize(topic.topic).filter(keep);

  // keyword -> (brand name -> topics carrying it)
  const kw = new Map();
  for (const b of allBrands) {
    for (const topic of b.topics) {
      for (const token of new Set(tokensOf(topic))) {
        let perBrand = kw.get(token);
        if (!perBrand) {
          perBrand = new Map();
          kw.set(token, perBrand);
        }
        let hits = perBrand.get(b.name);
        if (!hits) {
          hits = [];
          perBrand.set(b.name, hits);
        }
        hits.push(topic);
      }
    }
  }

  const themes = [];
  for (const [keyword, perBrand] of kw) {
    // Theme requires the anchor brand plus at least one competitor.
    if (perBrand.has(brand.name) && perBrand.size >= 2) {
      const members = allBrands
        .filter((b) => perBrand.has(b.name))
        .map((b) => {
          const rep = [...perBrand.get(b.name)]
            .sort((x, y) => (y.topic_volume ?? 0) - (x.topic_volume ?? 0))[0];
          return { brand: b.name, topic: rep };
        });
      const peakVolume = members.reduce((max, m) => Math.max(max, m.topic.topic_volume ?? 0), 0);
      const totalMentions = members.reduce((sum, m) => sum + (m.topic.mentions ?? 0), 0);
      themes.push({
        keywords: [keyword], members, brandCount: members.length, peakVolume, totalMentions,
      });
    }
  }

  // Merge themes whose representative topics are identical (same member topic set) — keeps
  // one theme with multiple keyword chips instead of near-duplicate rows.
  const merged = new Map();
  for (const theme of themes) {
    const sig = theme.members.map((m) => m.topic.topic_id ?? m.topic.topic).sort().join(' | ');
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
  result.sort((a, b) => b.peakVolume - a.peakVolume);
  return result;
}
