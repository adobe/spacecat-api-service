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
 * Competitor topic "relevance" — deliberately NOT a semantic/embedding match (no LLM call, no
 * vector similarity). A brand's AI-generated topic (`topic_name` + `description`) and a
 * competitor's are compared as plain keyword sets: strip every known brand/product/company name
 * token out of both, drop English stopwords and short noise tokens, then score the remaining
 * "subject" words with Jaccard similarity (intersection / union of the two token sets). Two
 * topics about the same SUBJECT (e.g. both about assembly complaints, or both about Labor Day
 * sales) score high even when neither mentions the other's brand at all — which is the point:
 * the score is about what the topic is about, not whose name is in it.
 */

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'with', 'in', 'on', 'to', 'is', 'are', 'this',
  'that', 'about', 'from', 'by', 'as', 'it', 'its', 'their', 'they', 'be', 'has', 'have', 'was',
  'were', 'will', 'can', 'more', 'most', 'than', 'also', 'not', 'but', 'which', 'these', 'those',
  'been', 'into', 'over', 'such', 'some', 'other', 'across', 'both', 'each', 'per', 'via',
]);

/** Tokens shorter than this are dropped as noise (initials, units, etc.). */
const MIN_TOKEN_LENGTH = 3;

function normalizeToken(rawToken) {
  return rawToken.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Every project's own name, split into individual word tokens, PLUS a small set of known Lovesac
 * product names — the OpenAPI topic schema has no separate "product" field, so these can't be
 * derived from structured data; they're read off the anomaly/topic text seen live in this same
 * project (see `docs`/session notes: "Sactional", "Squattoman", "Pillowsac" all appeared in real
 * Brand24 content for this account). Extend this list if a new product name shows up in topics
 * and skews a match.
 */
const KNOWN_PRODUCT_STOP_TERMS = ['sactional', 'sactionals', 'squattoman', 'pillowsac', 'sac', 'sacs'];

export function buildBrandStopTerms(projectNames) {
  const terms = new Set(KNOWN_PRODUCT_STOP_TERMS);
  for (const name of projectNames) {
    for (const word of String(name).split(/\s+/)) {
      const normalized = normalizeToken(word);
      if (normalized) {
        terms.add(normalized);
      }
    }
  }
  return terms;
}

function isSubjectToken(token, brandStopTerms) {
  if (!token || token.length < MIN_TOKEN_LENGTH) {
    return false;
  }
  if (STOPWORDS.has(token) || brandStopTerms.has(token)) {
    return false;
  }
  return true;
}

/**
 * The topic's "subject" token set — brand/product names and stopwords removed, so two topics
 * about the same thing match even if only one names its own brand.
 */
export function tokenizeTopicSubject(topic, brandStopTerms) {
  const text = `${topic?.topic_name ?? ''} ${topic?.description ?? ''}`;
  const tokens = new Set();
  for (const rawToken of text.split(/\s+/)) {
    const token = normalizeToken(rawToken);
    if (isSubjectToken(token, brandStopTerms)) {
      tokens.add(token);
    }
  }
  return tokens;
}

/** Intersection / union of two token sets — 0 when either is empty, 1 when they're identical. */
export function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 || setB.size === 0) {
    return 0;
  }
  let intersectionSize = 0;
  for (const token of setA) {
    if (setB.has(token)) {
      intersectionSize += 1;
    }
  }
  const unionSize = setA.size + setB.size - intersectionSize;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

/**
 * @param {object} args
 * @param {Array<object>} args.brandTopics - The brand's own `topics[]` (real Brand24 topic shape).
 * @param {Array<{projectId: string, projectName: string, topics: Array<object>}>}
 *   args.competitorTopicsByProject
 * @param {Set<string>} args.brandStopTerms - From `buildBrandStopTerms`.
 * @param {number} [args.minRelevanceScore] - Matches below this are dropped as noise, not
 *   "0% relevant".
 * @returns {Array<{topic: object, competitorMatches: Array<{competitorProjectId: string,
 *   competitorProjectName: string, topic: object, relevanceScore: number}>}>} One entry per
 *   brand topic, `competitorMatches` sorted highest-relevance first.
 */
export function computeCompetitorTopicMatches({
  brandTopics, competitorTopicsByProject, brandStopTerms, minRelevanceScore = 0.08,
}) {
  return brandTopics.map((brandTopic) => {
    const brandTokens = tokenizeTopicSubject(brandTopic, brandStopTerms);
    const competitorMatches = [];

    for (const { projectId, projectName, topics } of competitorTopicsByProject) {
      for (const competitorTopic of topics) {
        const competitorTokens = tokenizeTopicSubject(competitorTopic, brandStopTerms);
        const relevanceScore = jaccardSimilarity(brandTokens, competitorTokens);
        if (relevanceScore >= minRelevanceScore) {
          competitorMatches.push({
            competitorProjectId: projectId,
            competitorProjectName: projectName,
            topic: competitorTopic,
            relevanceScore,
          });
        }
      }
    }

    competitorMatches.sort((a, b) => b.relevanceScore - a.relevanceScore);
    return { topic: brandTopic, competitorMatches };
  });
}
