/*
 * Copyright 2025 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import {
  hasText, isNonEmptyObject, isValidUUID,
} from '@adobe/spacecat-shared-utils';
import { badRequest, notFound, ok } from '@adobe/spacecat-shared-http-utils';

const MOCK_JOB_ID = '9d222c6d-893e-4e79-8201-3c9ca16a0f39';

function PreflightController(dataAccess, log, env) {
  if (!isNonEmptyObject(dataAccess)) {
    throw new Error('Data access required');
  }

  if (!isNonEmptyObject(env)) {
    throw new Error('Environment object required');
  }

  function validateRequestData(data) {
    if (!isNonEmptyObject(data)) {
      throw new Error('Invalid request: missing application/json data');
    }

    if (!hasText(data.pageUrl)) {
      throw new Error('Invalid request: missing pageUrl in request data');
    }
  }

  const createPreflightJob = async (context) => {
    const { data } = context;

    try {
      validateRequestData(data);

      const funcVersion = context.func?.version;
      const isDev = /^ci\d*$/i.test(funcVersion);
      const pollUrl = `https://spacecat.experiencecloud.live/api/${isDev ? 'ci' : 'v1'}/preflight/jobs/${MOCK_JOB_ID}`;

      log.info(`Creating preflight job for pageUrl: ${data.pageUrl}`);

      // TODO: implement async job creation instead of mock data
      return ok({
        jobId: MOCK_JOB_ID,
        status: 'IN_PROGRESS',
        createdAt: '2019-08-24T14:15:22Z',
        pollUrl,
      });
    } catch (error) {
      log.error(`Failed to create preflight job: ${error.message}`);
      return badRequest(error.message);
    }
  };

  const getPreflightJobStatusAndResult = async (context) => {
    const jobId = context.params?.jobId;

    log.info(`Getting preflight job status for jobId: ${jobId}`);

    if (!isValidUUID(jobId)) {
      return badRequest('Invalid jobId');
    }
    //   TODO: implement async job fetch instead of mock data

    if (jobId === MOCK_JOB_ID) {
      return ok({
        jobId: MOCK_JOB_ID,
        status: 'COMPLETED',
        createdAt: '2019-08-24T14:15:22Z',
        updatedAt: '2019-08-24T14:15:22Z',
        startedAt: '2019-08-24T14:15:22Z',
        endedAt: '2019-08-24T14:15:22Z',
        recordExpiresAt: 0,
        result: {
          audits: [
            {
              name: 'metatags',
              type: 'seo',
              opportunities: [
                {
                  tagName: 'description',
                  tagContent: 'Enjoy.',
                  issue: 'Description too short',
                  issueDetails: '94 chars below limit',
                  seoImpact: 'Moderate',
                  seoRecommendation: '140-160 characters long',
                  aiSuggestion: 'Enjoy the best of Adobe Creative Cloud.',
                  aiRationale: "Short descriptions can be less informative and may not attract users' attention.",
                },
                {
                  tagName: 'title',
                  tagContent: 'Adobe',
                  issue: 'Title too short',
                  issueDetails: '20 chars below limit',
                  seoImpact: 'Moderate',
                  seoRecommendation: '40-60 characters long',
                  aiSuggestion: 'Adobe Creative Cloud: Your All-in-One Solution',
                  aiRationale: "Short titles can be less informative and may not attract users' attention.",
                },
              ],
            },
            {
              name: 'canonical',
              type: 'seo',
              opportunities: [
                {
                  check: 'canonical-url-4xx',
                  explanation: 'The canonical URL returns a 4xx error, indicating it is inaccessible, which can harm SEO visibility.',
                },
              ],
            },
          ],
        },
        error: {
          code: 'string',
          message: 'string',
          details: {},
        },
        metadata: {
          pageUrl: 'https://main--cc--adobecom.aem.page/drafts/narcis/creativecloud',
          submittedBy: 'string',
          tags: [
            'string',
          ],
        },
      });
    }

    return notFound(`Job with ID ${jobId} not found`);
  };

  return {
    createPreflightJob,
    getPreflightJobStatusAndResult,
  };
}

export default PreflightController;
