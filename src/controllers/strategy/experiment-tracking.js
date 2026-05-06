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

import { enableExperimentTrackingSchema } from '../../schemas/experiment-tracking.js';
import { saveStrategyWithLockException } from '../../support/strategy/save-with-lock-exception.js';

export const enableExperimentTrackingHandler = ({
  getStrategy, persist, audit, linkGeoExperiment,
}) => async (req, res) => {
  const parsed = enableExperimentTrackingSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
  }
  const { siteId, strategyId } = req.params;
  const strategy = await getStrategy(siteId, strategyId);
  if (!strategy) {
    return res.status(404).json({ error: 'strategy_not_found' });
  }
  if (strategy.status !== 'completed') {
    return res.status(423).json({ error: 'strategy_not_completed' });
  }
  if (strategy.experimentId) {
    return res.status(409).json({ error: 'already_tracking' });
  }

  const link = await linkGeoExperiment(parsed.data.experimentId, siteId);
  if (!link.ok) {
    return res.status(502).json({ error: 'geo_experiment_link_failed', reason: link.reason });
  }

  const updated = await saveStrategyWithLockException(
    strategy,
    { experimentId: parsed.data.experimentId },
    {
      allowedFields: ['experimentId'], persist, audit, actor: req.auth?.actor,
    },
  );

  return res.status(200).json({
    strategyId,
    experimentId: updated.experimentId,
    provider: parsed.data.provider,
    status: 'tracking',
    linkedAt: updated.updatedAt,
  });
};
