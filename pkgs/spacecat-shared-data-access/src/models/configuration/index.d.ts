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

import type {
  BaseCollection, BaseModel, Organization, Site,
} from '../index';

export interface Configuration extends BaseModel {
  addHandler(type: string, handler: object): void;
  disableHandlerForOrganization(type: string, organization: Organization): void;
  disableHandlerForSite(type: string, site: Site): void;
  enableHandlerForOrganization(type: string, organization: Organization): void;
  enableHandlerForSite(type: string, site: Site): void;
  getConfigurationId(): string;
  getEnabledSiteIdsForHandler(type: string): string[];
  getEnabledAuditsForSite(site: Site): string[];
  getHandler(type: string): object | undefined;
  getHandlers(): object;
  getJobs(): object;
  getQueues(): object;
  getSlackRoleMembersByRole(role: string): string[];
  getSlackRoles(): object;
  getVersion(): number;
  isHandlerEnabledForOrg(type: string, organization: Organization): boolean;
  isHandlerEnabledForSite(type: string, site: Site): boolean;
  setHandlers(handlers: object): void;
  setJobs(jobs: object): void;
  setQueues(queues: object): void;
  setSlackRoles(slackRoles: object): void;
  updateHandlerOrgs(type: string, orgId: string, enabled: boolean): void;
  updateHandlerSites(type: string, siteId: string, enabled: boolean): void;
}

export interface ConfigurationCollection extends BaseCollection<Configuration> {
  findByVersion(version: number): Promise<Configuration | null>;
  findLatest(): Promise<Configuration | null>;
}
