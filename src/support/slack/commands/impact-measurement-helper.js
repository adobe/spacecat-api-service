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

import { isValidUUID } from '@adobe/spacecat-shared-utils';

// Resolves the GeoExperiment to act on: the explicit id if given (validated against the site),
// else the site's most recently updated one. Returns { geoExperiment } or { errorMessage }.
export async function resolveGeoExperiment({
  GeoExperiment, site, baseURL, geoExperimentIdInput,
}) {
  if (geoExperimentIdInput) {
    if (!isValidUUID(geoExperimentIdInput)) {
      return { errorMessage: `:x: '${geoExperimentIdInput}' is not a valid geo-experiment id.` };
    }

    const geoExperiment = await GeoExperiment.findById(geoExperimentIdInput);
    if (!geoExperiment) {
      return { errorMessage: `:x: No geo-experiment found with id '${geoExperimentIdInput}'.` };
    }

    if (geoExperiment.getSiteId() !== site.getId()) {
      return {
        errorMessage: `:x: GeoExperiment ${geoExperimentIdInput} does not belong to '${baseURL}'.`,
      };
    }

    return { geoExperiment };
  }

  const { data: experiments } = await GeoExperiment.allBySiteId(site.getId());
  if (experiments.length === 0) {
    return { errorMessage: `:x: No geo-experiments found for '${baseURL}'.` };
  }

  // Ordered by most recently updated — first is current.
  const [geoExperiment] = experiments;
  return { geoExperiment };
}
