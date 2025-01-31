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
  BaseCollection, BaseModel, LatestAudit, Opportunity, QueryOptions, Site,
} from '../index';

export interface Audit extends BaseModel {
  getAuditedAt(): string;
  getAuditId(): string;
  getAuditResult(): object | [];
  getAuditType(): string;
  getFullAuditRef(): string;
  getIsError(): boolean;
  getIsLive(): boolean;
  getLatestAudit(): Promise<LatestAudit | null>;
  getLatestAuditByAuditType(auditType: string): Promise<LatestAudit | null>;
  getOpportunities(): Promise<Opportunity[]>;
  getOpportunitiesByUpdatedAt(updatedAt: string): Promise<Opportunity[]>;
  getScores(): object | undefined;
  getSite(): Promise<Site>;
  getSiteId(): string;
}

export interface AuditCollection extends BaseCollection<Audit> {
  allBySiteId(siteId: string): Promise<Audit[]>;
  allBySiteIdAndAuditType(
    siteId: string,
    auditType: string,
    options?: QueryOptions
  ): Promise<Audit[]>;
  allBySiteIdAndAuditTypeAndAuditedAt(
    siteId: string, auditType: string, auditedAt: string
  ): Promise<Audit[]>;
  findBySiteId(siteId: string): Promise<Audit | null>;
  findBySiteIdAndAuditType(siteId: string, auditType: string): Promise<Audit | null>;
  findBySiteIdAndAuditTypeAndAuditedAt(
    siteId: string, auditType: string, auditedAt: string
  ): Promise<Audit | null>;
}
