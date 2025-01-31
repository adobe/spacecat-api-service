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

export interface ApiKey extends BaseModel {
  getApiKeyId(): string;
  getDeletedAt(): string | undefined;
  getExpiresAt(): string | undefined;
  getHashedApiKey(): string;
  getImsOrgId(): string | undefined;
  getImsUserId(): string | undefined;
  getName(): string;
  getRevokedAt(): string | undefined;
  getScopes(): string[];
  setDeletedAt(deletedAt: string): void;
  setExpiresAt(expiresAt: string): void;
  setHashedApiKey(hashedApiKey: string): void;
  setImsOrgId(imsOrgId: string): void;
  setImsUserId(imsUserId: string): void;
  setName(name: string): void;
  setRevokedAt(revokedAt: string): void;
  setScopes(scopes: object[]): void;
}

export interface ApiKeyCollection extends BaseCollection<ApiKey> {
  allByHashedApiKey(hashedApiKey: string): Promise<ApiKey[]>;
  allByHashedApiKeyAndUpdatedAt(hashedApiKey: string, updatedAt: string): Promise<ApiKey[]>;
  allByImsOrgId(imsOrgId: string): Promise<ApiKey[]>;
  allByImsOrgIdAndImsUserId(imsOrgId: string, imsUserId: string): Promise<ApiKey[]>;
  allByImsOrgIdAndImsUserIdAndUpdatedAt(
    imsOrgId: string, imsUserId: string, updatedAt: string
  ): Promise<ApiKey[]>;
  findByHashedApiKey(hashedApiKey: string): Promise<ApiKey | null>;
  findByHashedApiKeyAndUpdatedAt(hashedApiKey: string, updatedAt: string): Promise<ApiKey | null>;
  findByImsOrgId(imsOrgId: string): Promise<ApiKey | null>;
  findByImsOrgIdAndImsUserId(imsOrgId: string, imsUserId: string): Promise<ApiKey | null>;
  findByImsOrgIdAndImsUserIdAndUpdatedAt(
    imsOrgId: string, imsUserId: string, updatedAt: string
  ): Promise<ApiKey | null>;
}
