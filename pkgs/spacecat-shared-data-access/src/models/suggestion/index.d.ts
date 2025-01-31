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

import type { BaseCollection, BaseModel, Opportunity } from '../index';

export interface Suggestion extends BaseModel {
  getData(): object;
  getKpiDeltas(): object;
  getOpportunity(): Promise<Opportunity>;
  getOpportunityId(): string;
  getRank(): number;
  getStatus(): string;
  getType(): string;
  setData(data: object): Suggestion;
  setKpiDeltas(kpiDeltas: object): Suggestion;
  setOpportunityId(opportunityId: string): Suggestion;
  setRank(rank: number): Suggestion;
  setStatus(status: string): Suggestion;
}

export interface SuggestionCollection extends BaseCollection<Suggestion> {
  allByOpportunityId(opportunityId: string): Promise<Suggestion[]>;
  allByOpportunityIdAndStatus(opportunityId: string, status: string): Promise<Suggestion[]>;
  bulkUpdateStatus(suggestions: Suggestion[], status: string): Promise<Suggestion[]>;
  findByOpportunityId(opportunityId: string): Promise<Suggestion | null>;
  findByOpportunityIdAndStatus(opportunityId: string, status: string): Promise<Suggestion | null>;
}
