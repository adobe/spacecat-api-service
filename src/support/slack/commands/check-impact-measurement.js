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

import { checkGeoExperimentImpactMeasurement } from '../../utils.js';
import { isImpactMeasurementCheckEligible } from '../../geo-experiment-helper.js';
import BaseCommand from './base.js';
import { extractURLFromSlackInput, postErrorMessage, postSiteNotFoundMessage } from '../../../utils/slack/base.js';

const PHRASES = ['check-impact-measurement'];

/**
 * Manually checks the in-flight Mystique impact-measurement task for a site's most recently
 * updated GeoExperiment, given the site's base URL/domain. Requests
 * llmo-experimentation-engine to poll Mystique and update the GeoExperiment if the task has
 * finished — this command does not itself return the completion result, since the update
 * happens asynchronously via the llmo-experimentation-engine-queue (fire-and-request, matching
 * trigger-impact-measurement's fire-and-forget shape). Run `get-site {baseURL}` or a follow-up
 * check after a short wait to see the updated phase/status.
 *
 * Needed because trigger-impact-measurement can re-arm a COMPLETED experiment while leaving it
 * COMPLETED (invisible to the engine's own cron sweep) — this is the manual entry point to
 * advance it. See llmo-experimentation-engine's
 * docs/decisions/007-manual-impact-measurement-check-completed-status.md.
 */
export default function CheckImpactMeasurementCommand(context) {
  const baseCommand = BaseCommand({
    id: 'check-impact-measurement',
    name: 'Check Impact Measurement',
    description: 'Manually checks an in-flight Mystique impact-measurement task for a site\'s geo-experiment.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {baseURL}`,
  });

  const { dataAccess, log, sqs } = context;
  const { Site, GeoExperiment } = dataAccess;

  const handleExecution = async (args, slackContext) => {
    const { say, user } = slackContext;

    try {
      const [baseURLInput] = args;
      const baseURL = extractURLFromSlackInput(baseURLInput);

      if (!baseURL) {
        await say(baseCommand.usage());
        return;
      }

      const site = await Site.findByBaseURL(baseURL);
      if (!site) {
        await postSiteNotFoundMessage(say, baseURL);
        return;
      }

      const { data: experiments } = await GeoExperiment.allBySiteId(site.getId());
      if (experiments.length === 0) {
        await say(`:x: No geo-experiments found for '${baseURL}'.`);
        return;
      }

      // allBySiteId is ordered by most recently updated — the first result is the current one.
      const [geoExperiment] = experiments;
      const geoExperimentId = geoExperiment.getId();

      if (!isImpactMeasurementCheckEligible(geoExperiment)) {
        await say(`:warning: GeoExperiment ${geoExperimentId} for '${baseURL}' is at phase `
          + `'${geoExperiment.getPhase()}' / status '${geoExperiment.getStatus()}' — a check `
          + 'only makes sense at phase \'impact_measurement_started\' (an impact-measurement task '
          + 'must be in flight). Use trigger-impact-measurement first if none is running.');
        return;
      }

      if (!sqs) {
        await say(':x: Cannot check impact measurement — missing SQS client.');
        return;
      }

      const triggeredBy = user || 'unknown';
      await checkGeoExperimentImpactMeasurement(
        geoExperimentId,
        triggeredBy,
        { sqs, env: context.env },
      );

      await say(`:mag: Requested a check of GeoExperiment ${geoExperimentId}'s impact measurement `
        + `('${baseURL}'). If Mystique has finished, the experimentation engine will update it `
        + 'shortly; otherwise it stays as-is until checked again.');
    } catch (error) {
      log.error(error);
      await postErrorMessage(say, error);
    }
  };

  baseCommand.init(context);

  return {
    ...baseCommand,
    handleExecution,
  };
}
