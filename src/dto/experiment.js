/*
 * Copyright 2024 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

/**
 * Data transfer object for Experiment.
 */
export const ExperimentDto = {

  /**
   * Converts an Experiment object into a JSON object.
   * @param {Readonly<Experiment>} experiment - Experiment object.
   * @returns {{
   * siteId: string,
   * expId: string,
   * name: string,
   * url: string,
   * type: string,
   * status: string,
   * startDate: string,
   * endDate: string,
   * variants: Array<object>,
   * updatedAt: date,
   * updatedBy: string,
   * conversionEventName: string,
   * conversionEventValue: string
   * }} JSON object.
   */
  toJSON: (experiment) => ({
    siteId: experiment.getSiteId(),
    expId: experiment.getExpId(),
    name: experiment.getName(),
    url: experiment.getUrl(),
    type: experiment.getType(),
    status: experiment.getStatus(),
    startDate: experiment.getStartDate(),
    endDate: experiment.getEndDate(),
    variants: experiment.getVariants(),
    updatedAt: experiment.getUpdatedAt(),
    updatedBy: experiment.getUpdatedBy(),
    conversionEventName: experiment.getConversionEventName(),
    conversionEventValue: experiment.getConversionEventValue(),
  }),
};
