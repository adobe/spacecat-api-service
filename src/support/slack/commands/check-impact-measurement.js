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
import { resolveGeoExperiment } from './impact-measurement-helper.js';
import BaseCommand from './base.js';
import { extractURLFromSlackInput, postErrorMessage, postSiteNotFoundMessage } from '../../../utils/slack/base.js';

const PHRASES = ['check-impact-measurement'];

// Manually requests a check of an in-flight Mystique impact-measurement task for a site's
// geo-experiment, resolved by domain (most recent) or an optional explicit geoExperimentId.
// Fire-and-request: the engine updates the experiment asynchronously if Mystique has finished.
// Entry point for a COMPLETED experiment re-armed by trigger-impact-measurement (which the
// engine's own cron sweep can't see).
export default function CheckImpactMeasurementCommand(context) {
  const baseCommand = BaseCommand({
    id: 'check-impact-measurement',
    name: 'Check Impact Measurement',
    description: 'Manually checks an in-flight Mystique impact-measurement task for a site\'s geo-experiment.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {baseURL} [geoExperimentId]`,
  });

  const { dataAccess, log, sqs } = context;
  const { Site, GeoExperiment } = dataAccess;

  const handleExecution = async (args, slackContext) => {
    const { say, user } = slackContext;

    try {
      const [baseURLInput, geoExperimentIdInput] = args;
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

      const { geoExperiment, errorMessage } = await resolveGeoExperiment({
        GeoExperiment, site, baseURL, geoExperimentIdInput,
      });
      if (errorMessage) {
        await say(errorMessage);
        return;
      }

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
