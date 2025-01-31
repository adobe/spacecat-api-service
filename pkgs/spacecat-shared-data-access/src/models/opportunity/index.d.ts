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
  Audit, BaseCollection, BaseModel, MultiStatusCreateResult, Site, Suggestion,
} from '../index';

export interface Opportunity extends BaseModel {
  addSuggestions(suggestions: object[]): Promise<MultiStatusCreateResult<Suggestion>>;
  getAudit(): Promise<Audit>;
  getAuditId(): string;
  getData(): object;
  getDescription(): string;
  getGuidance(): string;
  getOrigin(): string;
  getRunbook(): string;
  getSite(): Promise<Site>;
  getSiteId(): string;
  getStatus(): string;
  getSuggestions(): Promise<Suggestion[]>;
  getSuggestionsByStatus(status: string): Promise<Suggestion[]>;
  getSuggestionsByStatusAndRank(status: string, rank: string): Promise<Suggestion[]>;
  getTags(): string[];
  getTitle(): string;
  getType(): string;
  setAuditId(auditId: string): Opportunity;
  setData(data: object): Opportunity;
  setDescription(description: string): Opportunity;
  setGuidance(guidance: string): Opportunity;
  setOrigin(origin: string): Opportunity;
  setRunbook(runbook: string): Opportunity;
  setSiteId(siteId: string): Opportunity;
  setStatus(status: string): Opportunity;
  setTags(tags: string[]): Opportunity;
  setTitle(title: string): Opportunity;
}

export interface OpportunityCollection extends BaseCollection<Opportunity> {
  allByAuditId(auditId: string): Promise<Opportunity[]>;
  allByAuditIdAndUpdatedAt(auditId: string, updatedAt: string): Promise<Opportunity[]>;
  allBySiteId(siteId: string): Promise<Opportunity[]>;
  allBySiteIdAndStatus(siteId: string, status: string): Promise<Opportunity[]>;
  allBySiteIdAndStatusAndUpdatedAt(
    siteId: string, status: string, updatedAt: string
  ): Promise<Opportunity[]>;
  findByAuditId(auditId: string): Promise<Opportunity | null>;
  findByAuditIdAndUpdatedAt(auditId: string, updatedAt: string): Promise<Opportunity | null>;
  findBySiteId(siteId: string): Promise<Opportunity | null>;
  findBySiteIdAndStatus(siteId: string, status: string): Promise<Opportunity | null>;
  findBySiteIdAndStatusAndUpdatedAt(
    siteId: string, status: string, updatedAt: string
  ): Promise<Opportunity | null>;
}
