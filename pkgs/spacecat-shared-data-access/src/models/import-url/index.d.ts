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

import type { BaseCollection, BaseModel, ImportJob } from '../index';

export interface ImportUrl extends BaseModel {
  getFile(): string,
  getImportJob(): Promise<ImportJob>,
  getImportJobId(): string,
  getPath(): string,
  getReason(): string,
  getStatus(): string,
  getUrl(): string,
  setFile(file: string): void,
  setImportJobId(importJobId: string): void,
  setPath(path: string): void,
  setReason(reason: string): void,
  setStatus(status: string): void,
  setUrl(url: string): void,
}

export interface ImportUrlCollection extends BaseCollection<ImportUrl> {
  allByImportJobId(importJobId: string): Promise<ImportUrl[]>;
  allByImportUrlsByJobIdAndStatus(importJobId: string, status: string): Promise<ImportUrl[]>;
  findByImportJobId(importJobId: string): Promise<ImportUrl | null>;
  findByImportJobIdAndUrl(importJobId: string, url: string): Promise<ImportUrl | null>;
}
