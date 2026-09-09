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

import { triggerGeoExperimentImpactMeasurement } from '../../utils.js';
import { isImpactMeasurementEligible } from '../../geo-experiment-helper.js';
import { resolveGeoExperiment } from './impact-measurement-helper.js';
import BaseCommand from './base.js';
import { extractURLFromSlackInput, postErrorMessage, postSiteNotFoundMessage } from '../../../utils/slack/base.js';

const PHRASES = ['trigger-impact-measurement'];

// Manually (re-)triggers Mystique impact measurement for a site's geo-experiment, resolved by
// domain (most recent) or an optional explicit geoExperimentId. Mirrors the HTTP
// POST /sites/:siteId/geo-experiments/:geoExperimentId/trigger-impact-measurement endpoint.
export default function TriggerImpactMeasurementCommand(context) {
  const baseCommand = BaseCommand({
    id: 'trigger-impact-measurement',
    name: 'Trigger Impact Measurement',
    description: 'Manually (re-)triggers Mystique impact measurement for a site\'s geo-experiment.',
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

      if (!isImpactMeasurementEligible(geoExperiment)) {
        await say(`:warning: GeoExperiment ${geoExperimentId} for '${baseURL}' is at phase `
          + `'${geoExperiment.getPhase()}' / status '${geoExperiment.getStatus()}' — impact `
          + 'measurement can only be triggered at phase \'post_analysis_done\', '
          + '\'impact_measurement_started\', or \'impact_measurement_done\' with status '
          + '\'in_progress\' or \'completed\'.');
        return;
      }

      if (!sqs) {
        await say(':x: Cannot trigger impact measurement — missing SQS client.');
        return;
      }

      const triggeredBy = user || 'unknown';
      await triggerGeoExperimentImpactMeasurement(
        geoExperimentId,
        triggeredBy,
        { sqs, env: context.env },
      );

      await say(`:white_check_mark: Triggered impact measurement for GeoExperiment ${geoExperimentId} `
        + `('${baseURL}'). The experimentation engine will process it shortly.`);
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
