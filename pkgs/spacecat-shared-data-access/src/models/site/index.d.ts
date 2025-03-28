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
  Audit,
  BaseCollection,
  BaseModel,
  Experiment,
  KeyEvent,
  LatestAudit,
  Opportunity,
  Organization,
  SiteCandidate,
  SiteTopPage,
} from '../index';

export type IMPORT_TYPES = {
  readonly ORGANIC_KEYWORDS: 'organic-keywords';
  readonly ORGANIC_TRAFFIC: 'organic-traffic';
  readonly TOP_PAGES: 'top-pages';
};

export type IMPORT_DESTINATIONS = {
  readonly DEFAULT: 'default';
};

export type IMPORT_SOURCES = {
  readonly AHREFS: 'ahrefs';
  readonly GSC: 'google';
};

export type ImportType = 'organic-keywords' | 'organic-traffic' | 'top-pages';
export type ImportDestination = 'default';
export type ImportSource = 'ahrefs' | 'google';

export interface ImportConfig {
  type: ImportType;
  destinations: ImportDestination[];
  sources: ImportSource[];
  enabled: boolean;
  pageUrl?: string;
  geo?: string;
  limit?: number;
}

export interface SiteConfig {
  state: {
    slack?: {
      workspace?: string;
      channel?: string;
      invitedUserCount?: number;
    };
    imports?: ImportConfig[];
    handlers?: Record<string, {
      mentions?: Record<string, string[]>;
      excludedURLs?: string[];
      manualOverwrites?: Array<{
        brokenTargetURL?: string;
        targetURL?: string;
      }>;
      fixedURLs?: Array<{
        brokenTargetURL?: string;
        targetURL?: string;
      }>;
      includedURLs?: string[];
      groupedURLs?: Array<{
        name: string;
        pattern: string;
      }>;
      latestMetrics?: {
        pageViewsChange: number;
        ctrChange: number;
        projectedTrafficValue: number;
      };
      movingAvgThreshold?: number;
      percentageChangeThreshold?: number;
    }>;
    fetchConfig?: {
      headers?: Record<string, string>;
      overrideBaseURL?: string;
    };
  };
  getSlackConfig(): { workspace?: string; channel?: string; invitedUserCount?: number };
  getImports(): ImportConfig[];
  getImportConfig(type: ImportType): ImportConfig | undefined;
  isImportEnabled(type: ImportType): boolean;
  enableImport(type: ImportType, config?: Partial<ImportConfig>): void;
  disableImport(type: ImportType): void;
  getHandlers(): Record<string, object>;
  getHandlerConfig(type: string): object;
  getSlackMentions(type: string): string[] | undefined;
  getExcludedURLs(type: string): string[] | undefined;
  getManualOverwrites(type: string):
    Array<{ brokenTargetURL?: string; targetURL?: string }> | undefined;
  getFixedURLs(type: string): Array<{ brokenTargetURL?: string; targetURL?: string }> | undefined;
  getIncludedURLs(type: string): string[] | undefined;
  getGroupedURLs(type: string): Array<{ name: string; pattern: string }> | undefined;
  getLatestMetrics(type: string):
    { pageViewsChange: number; ctrChange: number; projectedTrafficValue: number } | undefined;
  getFetchConfig(): { headers?: Record<string, string>, overrideBaseURL?: string } | undefined;
}

export interface Site extends BaseModel {
  getAudits(): Promise<Audit>;
  getAuditsByAuditType(auditType: string): Promise<Audit>;
  getAuditsByAuditTypeAndAuditedAt(auditType: string, auditedAt: string): Promise<Audit>;
  getBaseURL(): string;
  getName(): string;
  getConfig(): SiteConfig;
  getDeliveryType(): string;
  getExperiments(): Promise<Experiment[]>;
  getExperimentsByExpId(expId: string): Promise<Experiment[]>;
  getExperimentsByExpIdAndUrl(expId: string, url: string): Promise<Experiment[]>;
  getExperimentsByExpIdAndUrlAndUpdatedAt(
    expId: string, url: string, updatedAt: string
  ): Promise<Experiment[]>;
  getGitHubURL(): string;
  getHlxConfig(): object;
  getDeliveryConfig(): object;
  getIsLive(): boolean;
  getIsLiveToggledAt(): string;
  getKeyEvents(): Promise<KeyEvent[]>
  getKeyEventsByTimestamp(timestamp: string): Promise<KeyEvent[]>
  getLatestAudit(): Promise<LatestAudit>;
  getLatestAudits(): Promise<LatestAudit>;
  getLatestAuditByAuditType(auditType: string): Promise<LatestAudit>;
  getOpportunities(): Promise<Opportunity[]>;
  getOpportunitiesByStatus(status: string): Promise<Opportunity[]>;
  getOpportunitiesByStatusAndUpdatedAt(status: string, updatedAt: string): Promise<Opportunity[]>;
  getOrganization(): Promise<Organization>;
  getOrganizationId(): string;
  getSiteCandidates(): Promise<SiteCandidate[]>;
  getSiteTopPages(): Promise<SiteTopPage[]>;
  getSiteTopPagesBySource(source: string): Promise<SiteTopPage[]>;
  getSiteTopPagesBySourceAndGeo(source: string, geo: string): Promise<SiteTopPage[]>;
  getSiteTopPagesBySourceAndGeoAndTraffic(
    source: string, geo: string, traffic: string
  ): Promise<SiteTopPage[]>;
  setBaseURL(baseURL: string): Site;
  setName(name: string): Site;
  setConfig(config: object): Site;
  setDeliveryType(deliveryType: string): Site;
  setGitHubURL(gitHubURL: string): Site;
  setHlxConfig(hlxConfig: object): Site;
  setDeliveryConfig(deliveryConfig: object): Site;
  setIsLive(isLive: boolean): Site;
  setIsLiveToggledAt(isLiveToggledAt: string): Site;
  setOrganizationId(organizationId: string): Site;
  toggleLive(): Site;
}

export interface SiteCollection extends BaseCollection<Organization> {
  allByBaseURL(baseURL: string): Promise<Site[]>;
  allByDeliveryType(deliveryType: string): Promise<Site[]>;
  allByOrganizationId(organizationId: string): Promise<Site[]>;
  allSitesToAudit(): Promise<string[]>;
  allWithLatestAudit(auditType: string, order?: string, deliveryType?: string): Promise<Site[]>;
  findByBaseURL(baseURL: string): Promise<Site | null>;
  findByDeliveryType(deliveryType: string): Promise<Site | null>;
  findByOrganizationId(organizationId: string): Promise<Site | null>;
}
