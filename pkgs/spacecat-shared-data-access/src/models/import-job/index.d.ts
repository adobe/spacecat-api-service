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

import type { BaseCollection, BaseModel } from '../base';
import type { ImportUrl } from '../import-url';

export interface ImportJob extends BaseModel {
  getBaseURL(): string,
  getDuration(): number,
  getEndedAt(): string,
  getFailedCount(): number,
  getHasCustomHeaders(): boolean,
  getHasCustomImportJs(): boolean,
  getHashedApiKey(): string,
  getImportQueueId(): string,
  getImportUrls(): Promise<ImportUrl[]>,
  getImportUrlsByStatus(status: string): Promise<ImportUrl[]>,
  getInitiatedBy(): string,
  getOptions(): string,
  getRedirectCount(): number,
  getStartedAt(): string,
  getStatus(): string,
  getSuccessCount(): number,
  getUrlCount(): number,
  setBaseURL(baseURL: string): void,
  setDuration(duration: number): void,
  setEndedAt(endTime: string): void,
  setFailedCount(failedCount: number): void,
  setHasCustomHeaders(hasCustomHeaders: boolean): void,
  setHasCustomImportJs(hasCustomImportJs: boolean): void,
  setHashedApiKey(hashedApiKey: string): void,
  setImportQueueId(importQueueId: string): void,
  setInitiatedBy(initiatedBy: string): void,
  setOptions(options: string): void,
  setRedirectCount(redirectCount: number): void,
  setStatus(status: string): void,
  setSuccessCount(successCount: number): void,
  setUrlCount(urlCount: number): void,
}

export interface ImportJobCollection extends BaseCollection<ImportJob> {
  allByDateRange(startDate: string, endDate: string): Promise<ImportJob[]>;
  allByStartedAt(startDate: string): Promise<ImportJob[]>;
  allByStatus(status: string): Promise<ImportJob[]>;
  allByStatusAndUpdatedAt(status: string, updatedAt: string): Promise<ImportJob[]>;
  findByStartedAt(startDate: string): Promise<ImportJob | null>;
  findByStatus(status: string): Promise<ImportJob | null>;
  findByStatusAndUpdatedAt(status: string, updatedAt: string): Promise<ImportJob | null>;
}
