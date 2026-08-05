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

import { GeoExperiment } from '@adobe/spacecat-shared-data-access';
import { isValidUUID } from '@adobe/spacecat-shared-utils';

import BaseCommand from './base.js';
import { postErrorMessage } from '../../../utils/slack/base.js';
import { triggerGeoExperimentImpactMeasurement } from '../../utils.js';

const PHRASES = ['trigger impact measurement'];

const { STATUSES, PHASES, METADATA_KEYS } = GeoExperiment;

// Phases at which the experiment has reached (or passed) post-analysis, i.e. there is DRS
// post-analysis data for Mystique to measure. Earlier phases have nothing to measure yet. This
// mirrors llmo-experimentation-engine's own eligibility check (which is authoritative — the
// engine re-validates on receipt) — checked here only so the Slack reply is immediate and
// accurate instead of "sent, wait and see".
// See llmo-experimentation-engine/docs/decisions/004-manual-impact-measurement-retrigger.md.
const MEASUREMENT_ELIGIBLE_PHASES = [
  PHASES.POST_ANALYSIS_DONE,
  PHASES.IMPACT_MEASUREMENT_STARTED,
  PHASES.IMPACT_MEASUREMENT_DONE,
];

/**
 * Factory function to create the TriggerImpactMeasurementCommand object.
 *
 * @param {Object} context - The context object.
 * @returns {TriggerImpactMeasurementCommand} The command object.
 * @constructor
 */
function TriggerImpactMeasurementCommand(context) {
  const baseCommand = BaseCommand({
    id: 'trigger-impact-measurement',
    name: 'Trigger Impact Measurement',
    description: 'Manually (re-)trigger Mystique impact measurement for a GeoExperiment. Only'
      + ' allowed once the experiment has reached post-analysis, and never resubmits while a'
      + ' measurement task is already in flight.',
    phrases: PHRASES,
    usageText: `${PHRASES[0]} {geoExperimentId}`,
  });

  const { dataAccess, log } = context;
  const { GeoExperiment: GeoExperimentCollection } = dataAccess;

  /**
   * Validates input, loads the GeoExperiment for an immediate eligibility read, and — if
   * eligible — sends a TRIGGER_IMPACT_MEASUREMENT message to the llmo-experimentation-engine-queue
   * so the engine re-arms and resubmits it via its normal handlePostAnalysisCompleted path.
   *
   * @param {string[]} args - The arguments provided to the command ([geoExperimentId]).
   * @param {Object} slackContext - The Slack context object.
   * @param {Function} slackContext.say - The Slack say function.
   * @returns {Promise} A promise that resolves when the operation is complete.
   */
  const handleExecution = async (args, slackContext) => {
    const { say } = slackContext;

    try {
      const [geoExperimentId] = args;

      if (!isValidUUID(geoExperimentId)) {
        await say(baseCommand.usage());
        return;
      }

      const geoExperiment = await GeoExperimentCollection.findById(geoExperimentId);
      if (!geoExperiment) {
        await say(`:x: GeoExperiment \`${geoExperimentId}\` not found.`);
        return;
      }

      const phase = geoExperiment.getPhase();
      const status = geoExperiment.getStatus();

      if (!MEASUREMENT_ELIGIBLE_PHASES.includes(phase)) {
        await say(`:x: GeoExperiment \`${geoExperimentId}\` is at phase \`${phase}\` and has not`
          + ' reached post-analysis yet — impact measurement cannot be triggered.');
        return;
      }

      const inFlight = phase === PHASES.IMPACT_MEASUREMENT_STARTED
        && status === STATUSES.IN_PROGRESS;
      if (inFlight) {
        const taskId = geoExperiment.getMetadata()?.[METADATA_KEYS.IMPACT_MEASUREMENT_TASK_ID];
        await say(`:hourglass_flowing_sand: GeoExperiment \`${geoExperimentId}\` already has an`
          + ` impact measurement task in flight (Mystique task \`${taskId || 'unknown'}\`). Not`
          + ' re-triggering.');
        return;
      }

      await triggerGeoExperimentImpactMeasurement(geoExperimentId, slackContext, context);

      log.info('[geo-experiment] Sent manual impact-measurement trigger for GeoExperiment'
        + ` ${geoExperimentId} (phase: ${phase}, status: ${status})`);

      await say(':white_check_mark: Triggered impact measurement for GeoExperiment'
        + ` \`${geoExperimentId}\`. The experimentation engine will process it shortly.`);
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

export default TriggerImpactMeasurementCommand;
