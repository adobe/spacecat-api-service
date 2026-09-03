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

import { resolveGeoExperiment } from './impact-measurement-helper.js';
import BaseCommand from './base.js';
import { extractURLFromSlackInput, postErrorMessage, postSiteNotFoundMessage } from '../../../utils/slack/base.js';

const PHRASES = ['get-experiment'];

const DASH = '—';

// Short value or an em-dash placeholder when absent, so every row stays aligned and readable.
const orDash = (value) => (value === undefined || value === null || value === '' ? DASH : value);

// One concise, emoji-led summary line per meaningful facet of the experiment.
function formatExperimentSummary(geoExperiment, baseURL) {
  const metadata = geoExperiment.getMetadata() || {};
  const metadataKeys = Object.keys(metadata);
  const suggestionIds = geoExperiment.getSuggestionIds() || [];
  const error = geoExperiment.getError();

  const lines = [
    `:test_tube: *GeoExperiment* \`${geoExperiment.getId()}\` — ${orDash(geoExperiment.getName())}`,
    `:globe_with_meridians: *Site:* ${baseURL}`,
    `:label: *Type:* ${orDash(geoExperiment.getType())}`,
    `:round_pushpin: *Phase:* \`${geoExperiment.getPhase()}\`   :vertical_traffic_light: *Status:* \`${geoExperiment.getStatus()}\``,
    `:dart: *Opportunity:* ${orDash(geoExperiment.getOpportunityId())}`,
    `:bar_chart: *Prompts:* ${orDash(geoExperiment.getPromptsCount())} · :jigsaw: *Suggestions:* ${suggestionIds.length}`,
    `:bulb: *Insights:* ${orDash(geoExperiment.getInsightsLocation())}`,
    `:hourglass: *Window:* ${orDash(geoExperiment.getStartTime())} → ${orDash(geoExperiment.getEndTime())}`,
    `:calendar: *Created:* ${orDash(geoExperiment.getCreatedAt())} · *Updated:* ${orDash(geoExperiment.getUpdatedAt())} (by ${orDash(geoExperiment.getUpdatedBy())})`,
    `:card_index_dividers: *Metadata:* ${metadataKeys.length ? metadataKeys.join(', ') : DASH}`,
  ];

  if (error) {
    const errorText = typeof error === 'string'
      ? error
      : (error.message || JSON.stringify(error));
    lines.push(`:rotating_light: *Error:* ${errorText}`);
  }

  return lines.join('\n');
}

// Prints a concise, emoji-led summary of a site's geo-experiment (resolved by domain — most
// recent — or an optional explicit geoExperimentId) so operators can eyeball its state at a glance.
export default function GetExperimentCommand(context) {
  const baseCommand = BaseCommand({
    id: 'get-experiment',
    name: 'Get Experiment',
    description: 'Shows a concise summary of a site\'s geo-experiment and its metadata.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {baseURL} [geoExperimentId]`,
  });

  const { dataAccess, log } = context;
  const { Site, GeoExperiment } = dataAccess;

  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;

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

      await say(formatExperimentSummary(geoExperiment, baseURL));
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
