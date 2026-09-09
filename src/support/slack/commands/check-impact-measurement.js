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
import { getImpactMeasurementOutcome, IMPACT_MEASUREMENT_OUTCOME } from '../../geo-experiment-helper.js';
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
      const outcome = getImpactMeasurementOutcome(geoExperiment);

      // Already terminal: report success/failure based on whether insights actually got filled,
      // rather than refusing because no task is in flight.
      if (outcome === IMPACT_MEASUREMENT_OUTCOME.SUCCEEDED) {
        await say(`:white_check_mark: GeoExperiment ${geoExperimentId} for '${baseURL}' has `
          + 'completed impact measurement — insights are available at '
          + `\`${geoExperiment.getInsightsLocation()}\`.`);
        return;
      }

      if (outcome === IMPACT_MEASUREMENT_OUTCOME.COMPLETED_WITHOUT_INSIGHTS) {
        await say(`:x: GeoExperiment ${geoExperimentId} for '${baseURL}' completed without insights `
          + `(phase '${geoExperiment.getPhase()}') — the impact measurement produced no data. `
          + 'Use trigger-impact-measurement to re-run it.');
        return;
      }

      if (outcome === IMPACT_MEASUREMENT_OUTCOME.NOT_APPLICABLE) {
        await say(`:warning: GeoExperiment ${geoExperimentId} for '${baseURL}' is at phase `
          + `'${geoExperiment.getPhase()}' / status '${geoExperiment.getStatus()}' — no `
          + 'impact-measurement task is in flight to check. Use trigger-impact-measurement first '
          + 'if none is running.');
        return;
      }

      // IN_FLIGHT: a task is running — fire the async check and let the engine update the record.
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
        + 'shortly; re-run check-impact-measurement to see the result.');
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
