/*
 * Copyright 2023 Adobe. All rights reserved.
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
 * Data transfer object for Site.
 */
export const OpportunityDto = {

  /**
   * Converts an Opportunity object into a JSON object.
   * scopeType and scopeId are intentionally omitted — they are brand-internal fields
   * that must only appear in the brand-scoped endpoint response, added by the brand
   * controller directly. Including them here would expose brand UUIDs on shared sites
   * to users who have site access but not brand access.
   *
   * Translations for `title` and `description` are stored by audit workers in
   * `opportunity.data.i18n` as a map of locale → { title, description }.
   * When `locale` is supplied the matching translation is promoted to the top-level
   * fields and `data.i18n` is stripped from the response so the shape stays stable.
   * Falls back to the original English values when the locale is absent or not found.
   *
   * @param {Readonly<Opportunity>} oppty - Opportunity object.
   * @param {string|null} [locale] - Optional locale code (e.g. 'fr_fr', 'ja_jp').
   * @returns {{
    * id: string,
    * siteId: string,
    * auditId: string,
    * runbook: string,
    * type: string,
    * data: object,
    * origin: string,
    * title: string,
    * description: string,
    * guidance: object,
    * tags: Array<string>,
    * createdAt: date,
    * updatedAt: date,
    * updatedBy: string,
    * lastAuditedAt: date
    * }} JSON object.
   */
  toJSON: (oppty, locale = null) => {
    const rawData = oppty.getData();
    const data = rawData ? (() => {
      // eslint-disable-next-line no-unused-vars
      const { i18n, ...rest } = rawData;
      return rest;
    })() : null;

    let title = oppty.getTitle();
    let description = oppty.getDescription();

    if (locale && rawData?.i18n?.[locale]) {
      const localized = rawData.i18n[locale];
      if (localized.title != null) {
        title = localized.title;
      }
      if (localized.description != null) {
        description = localized.description;
      }
    }

    return {
      id: oppty.getId(),
      siteId: oppty.getSiteId(),
      auditId: oppty.getAuditId(),
      runbook: oppty.getRunbook(),
      type: oppty.getType(),
      data,
      origin: oppty.getOrigin(),
      title,
      description,
      guidance: oppty.getGuidance(),
      tags: oppty.getTags(),
      status: oppty.getStatus(),
      createdAt: oppty.getCreatedAt(),
      updatedAt: oppty.getUpdatedAt(),
      updatedBy: oppty.getUpdatedBy(),
      lastAuditedAt: oppty.getLastAuditedAt(),
    };
  },
};
