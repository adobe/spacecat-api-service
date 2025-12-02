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
 * Data transfer object for URL.
 */
export const UrlDto = {

  /**
   * Converts a URL object into a JSON object.
   * @param {Readonly<Url>} url - URL object.
   * @returns {{
    * id: string,
    * url: string,
    * type: string,
    * status: string,
    * siteId: string,
    * metadata: object,
    * createdAt: date,
    * updatedAt: date
    * }} JSON object.
   */
  toJSON: (url) => ({
    id: url.getId(),
    url: url.getUrl(),
    type: url.getType(),
    status: url.getStatus(),
    siteId: url.getSiteId(),
    metadata: url.getMetadata(),
    createdAt: url.getCreatedAt(),
    updatedAt: url.getUpdatedAt(),
  }),
};





