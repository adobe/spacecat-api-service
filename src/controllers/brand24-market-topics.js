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
 * Cross-project competitor topic relevance (POC — Market Topics tab,
 * project-elmo-ui). Brand24 has no cross-project comparison of its own —
 * each project (brand) only ever returns its own `topics`. This fetches the
 * brand's own topics PLUS each named competitor project's topics (this
 * account's Ikea/West Elm/Pottery Barn projects, confirmed live via
 * `projects-list`) and scores every brand-topic-vs-competitor-topic pair with
 * a non-semantic, keyword-overlap relevance score (see
 * `support/brand24/marketTopicsRelevance.js` for exactly how and why it's
 * NOT an embedding/LLM match). Computed server-side, not in the browser, per
 * the ask — this is real cross-request business logic (N upstream calls +
 * scoring), not a single passthrough like `GET /tools/brand24`.
 */

import { badRequest, ok, internalServerError } from '@adobe/spacecat-shared-http-utils';
import { callBrand24Endpoint } from '../support/brand24/client.js';
import { buildBrandStopTerms, computeCompetitorTopicMatches } from '../support/brand24/marketTopicsRelevance.js';
import { parsePositiveInt, validateDateRange } from '../support/brand24/validation.js';

/**
 * This account's real competitor projects for the Lovesac POC — confirmed live via
 * `projects-list`, not guessed. Overridable per-request via `?competitor_project_names=`.
 */
const DEFAULT_COMPETITOR_PROJECT_NAMES = ['Ikea', 'West Elm', 'Pottery Barn'];

function Brand24MarketTopicsController(context, log, env) {
  const getMarketTopics = async (reqContext) => {
    const params = new URL(reqContext.request.url).searchParams;

    const dateFrom = params.get('date_from');
    const dateTo = params.get('date_to');
    const rangeError = validateDateRange(dateFrom, dateTo, 31);
    if (rangeError) {
      return badRequest(rangeError);
    }

    const brandProjectId = parsePositiveInt(params.get('project_id'));
    if (!brandProjectId) {
      return badRequest('Missing or invalid project_id');
    }

    const competitorNamesParam = params.get('competitor_project_names');
    const competitorProjectNames = competitorNamesParam
      ? competitorNamesParam.split(',').map((name) => name.trim()).filter(Boolean)
      : DEFAULT_COMPETITOR_PROJECT_NAMES;

    let projects;
    try {
      const projectsList = await callBrand24Endpoint({ endpointKey: 'projects-list', env });
      projects = projectsList.projects_list ?? projectsList;
    } catch (error) {
      log.error('[brand24-market-topics] failed to resolve projects list', error);
      return internalServerError('Failed to reach Brand24');
    }

    const brandProjectName = projects[String(brandProjectId)];
    if (!brandProjectName) {
      return badRequest(`No Brand24 project found for project_id "${brandProjectId}"`);
    }

    const competitorProjects = competitorProjectNames
      .map((wantedName) => {
        const match = Object.entries(projects)
          .find(([, projectName]) => projectName.toLowerCase() === wantedName.toLowerCase());
        return match ? { projectId: match[0], projectName: match[1] } : null;
      })
      .filter((project) => project !== null);

    const fetchTopics = async (projectId) => {
      const response = await callBrand24Endpoint({
        endpointKey: 'topics',
        pathValues: { project_id: projectId },
        query: { date_from: dateFrom, date_to: dateTo },
        env,
      });
      return response?.topics ?? [];
    };

    let brandTopics;
    let competitorTopicsByProject;
    try {
      brandTopics = await fetchTopics(brandProjectId);
      competitorTopicsByProject = await Promise.all(
        competitorProjects.map(async ({ projectId, projectName }) => ({
          projectId,
          projectName,
          topics: await fetchTopics(projectId),
        })),
      );
    } catch (error) {
      log.error('[brand24-market-topics] failed to fetch topics', error);
      return internalServerError('Failed to fetch topics from Brand24');
    }

    const brandStopTerms = buildBrandStopTerms([
      brandProjectName,
      ...competitorProjects.map((project) => project.projectName),
    ]);

    const topics = computeCompetitorTopicMatches({
      brandTopics,
      competitorTopicsByProject,
      brandStopTerms,
    });

    return ok({
      brand_project_id: String(brandProjectId),
      brand_project_name: brandProjectName,
      competitor_projects: competitorProjects.map((project) => ({
        competitor_project_id: project.projectId,
        competitor_project_name: project.projectName,
      })),
      topics: topics.map(({ topic, competitorMatches }) => ({
        ...topic,
        competitor_matches: competitorMatches.map((competitorMatch) => ({
          competitor_project_id: competitorMatch.competitorProjectId,
          competitor_project_name: competitorMatch.competitorProjectName,
          relevance_score: competitorMatch.relevanceScore,
          topic: competitorMatch.topic,
        })),
      })),
    });
  };

  return { getMarketTopics };
}

export default Brand24MarketTopicsController;
