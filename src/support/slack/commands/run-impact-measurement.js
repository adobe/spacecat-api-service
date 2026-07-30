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

import { hasText, isNonEmptyArray, isValidUrl } from '@adobe/spacecat-shared-utils';

import BaseCommand from './base.js';
import {
  extractURLFromSlackInput,
  postErrorMessage,
  postSiteNotFoundMessage,
} from '../../../utils/slack/base.js';

const PHRASES = ['run impact measurement'];

// SQS message type dispatched to the llmo-experimentation-engine's handler registry. The engine
// looks up its handler by this `type` and runs the impact-measurement workflow for the experiment.
const MESSAGE_TYPE = 'run-impact-measurement';

/**
 * Manually triggers the impact-measurement workflow for a geo-experiment. The command resolves the
 * site by domain, picks the target experiment, and enqueues a message onto the
 * llmo-experimentation-engine queue — the engine then runs the workflow end-to-end for that
 * experiment (trigger Mystique task, poll, store insights, complete).
 *
 * @param {object} context - The command context ({ dataAccess, sqs, env, log }).
 * @returns {object} The command object.
 */
function RunImpactMeasurementCommand(context) {
  const baseCommand = BaseCommand({
    id: 'run-impact-measurement',
    name: 'Run Impact Measurement',
    description: 'Manually trigger the impact-measurement workflow for a geo-experiment (dispatched to the llmo-experimentation-engine).',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {site} [experimentId]`,
  });

  const {
    dataAccess, sqs, env, log,
  } = context;
  const { Site, GeoExperiment } = dataAccess;

  /**
   * Resolve the target experiment: the explicit id when provided (validated against the site), else
   * the site's single experiment. Returns { experiment } on success, or { error } (a user message).
   */
  const resolveExperiment = async (site, experimentId) => {
    if (hasText(experimentId)) {
      const experiment = await GeoExperiment.findById(experimentId);
      if (!experiment || experiment.getSiteId() !== site.getId()) {
        return { error: `:warning: No geo-experiment \`${experimentId}\` found for this site.` };
      }
      return { experiment };
    }

    const { data: experiments } = await GeoExperiment.allBySiteId(site.getId());
    if (!isNonEmptyArray(experiments)) {
      return { error: ':warning: No geo-experiments found for this site.' };
    }
    if (experiments.length > 1) {
      const list = experiments
        .map((e) => `• \`${e.getId()}\` — ${e.getName?.() ?? 'experiment'} (${e.getStatus?.() ?? 'unknown'})`)
        .join('\n');
      return { error: `:warning: Multiple geo-experiments found — re-run with an experiment id:\n${list}` };
    }
    return { experiment: experiments[0] };
  };

  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;

    try {
      const [baseURLInput, experimentId] = args;
      const baseURL = extractURLFromSlackInput(baseURLInput);

      if (!isValidUrl(baseURL)) {
        await say(baseCommand.usage());
        return;
      }

      const queueUrl = env?.LLMO_EXPERIMENTATION_ENGINE_QUEUE_URL;
      if (!hasText(queueUrl)) {
        await say(':warning: The experimentation-engine queue is not configured (LLMO_EXPERIMENTATION_ENGINE_QUEUE_URL).');
        return;
      }

      const site = await Site.findByBaseURL(baseURL);
      if (!site) {
        await postSiteNotFoundMessage(say, baseURL);
        return;
      }

      const { experiment, error } = await resolveExperiment(site, experimentId);
      if (error) {
        await say(error);
        return;
      }

      const message = {
        type: MESSAGE_TYPE,
        siteId: site.getId(),
        geoExperimentId: experiment.getId(),
      };
      await sqs.sendMessage(queueUrl, message);

      log.info(`[run-impact-measurement] enqueued for site=${site.getId()} experiment=${experiment.getId()}`);
      await say(`:white_check_mark: Impact measurement triggered for experiment \`${experiment.getId()}\` (${baseURL}). The experimentation engine will run the workflow.`);
    } catch (error) {
      log.error('Error triggering impact measurement:', error);
      await postErrorMessage(say, error);
    }
  };

  baseCommand.init(context);

  return {
    ...baseCommand,
    handleExecution,
  };
}

export default RunImpactMeasurementCommand;
