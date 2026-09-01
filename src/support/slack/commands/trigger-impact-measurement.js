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
import BaseCommand from './base.js';
import { extractURLFromSlackInput, postErrorMessage, postSiteNotFoundMessage } from '../../../utils/slack/base.js';

const PHRASES = ['trigger-impact-measurement'];

/**
 * Manually (re-)triggers Mystique impact measurement for a site's most recently updated
 * GeoExperiment, given the site's base URL/domain. Mirrors the HTTP
 * `POST /sites/:siteId/geo-experiments/:geoExperimentId/trigger-impact-measurement` endpoint
 * (src/controllers/suggestions.js#triggerImpactMeasurement) but resolves the GeoExperiment by
 * site domain instead of requiring the caller to already have a geoExperimentId, so an operator
 * can act directly from a domain reported in Slack/monitoring.
 *
 * See llmo-experimentation-engine's
 * docs/decisions/004-manual-impact-measurement-retrigger.md and
 * docs/decisions/007-manual-impact-measurement-check-completed-status.md.
 */
export default function TriggerImpactMeasurementCommand(context) {
  const baseCommand = BaseCommand({
    id: 'trigger-impact-measurement',
    name: 'Trigger Impact Measurement',
    description: 'Manually (re-)triggers Mystique impact measurement for a site\'s geo-experiment.',
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
