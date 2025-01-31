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

import type { ValidationError } from '../../errors';

export interface MultiStatusCreateResult<T> {
  createdItems: T[],
  errorItems: { item: object, error: ValidationError }[],
}

export interface BaseModel {
  _remove(): Promise<this>;
  getCreatedAt(): string;
  getId(): string;
  getRecordExpiresAt(): string;
  getUpdatedAt(): string;
  remove(): Promise<this>;
  save(): Promise<this>;
  toJSON(): object;
}

export interface QueryOptions {
  index?: string;
  limit?: number;
  order?: string;
  attributes?: string[];
}

export interface BaseCollection<T extends BaseModel> {
  _onCreate(item: T): void;
  _onCreateMany(items: MultiStatusCreateResult<T>): void;
  _saveMany(items: T[]): Promise<T[]>;
  all(sortKeys?: object, options?: QueryOptions): Promise<T[]>;
  allByIndexKeys(keys: object, options?: QueryOptions): Promise<T[]>;
  create(item: object): Promise<T>;
  createMany(items: object[], parent?: T): Promise<MultiStatusCreateResult<T>>;
  existsById(id: string): Promise<boolean>;
  findByAll(sortKeys?: object, options?: QueryOptions): Promise<T> | null;
  findById(id: string): Promise<T> | null;
  findByIndexKeys(indexKeys: object): Promise<T>;
  removeByIds(ids: string[]): Promise<void>;
}

export interface EntityRegistry {
  getCollection<T extends BaseModel>(collectionName: string): BaseCollection<T>;
  getCollections(): BaseCollection<BaseModel>[];
  getEntities(): object;
  registerEntity(schema: object, collection: BaseCollection<BaseModel>): void;
}

export interface Reference {
  getSortKeys(): string[];
  getTarget(): string;
  getType(): string;
  isRemoveDependents(): boolean;
  toAccessorConfigs(): object[];
}

export interface IndexAccessor {
  indexName: string;
  keySets: string[][];
}

export interface Schema {
  allowsRemove(): boolean;
  allowsUpdates(): boolean;
  findIndexBySortKeys(sortKeys: string[]): object | null;
  findIndexByType(type: string): object | null;
  findIndexNameByKeys(keys: object): string;
  getAttribute(name: string): object;
  getAttributes(): object;
  getCollectionName(): string;
  getEntityName(): string;
  getIdName(): string;
  getIndexAccessors(): Array<IndexAccessor>;
  getIndexByName(indexName: string): object;
  getIndexKeys(indexName: string): string[];
  getIndexTypes(): string[];
  getIndexes(): object;
  getModelClass(): object;
  getModelName(): string;
  getReciprocalReference(registry: EntityRegistry, reference: Reference): Reference | null;
  getReferenceByTypeAndTarget(referenceType: string, target: string): Reference | undefined;
  getReferences(): Reference[];
  getReferencesByType(referenceType: string): Reference[];
  getServiceName(): string;
  getVersion(): number;
  toAccessorConfigs(): object[];
  toElectroDBSchema(): object;
}

export interface SchemaBuilder {
  addAllIndex(sortKeys: string[]): SchemaBuilder;
  addAttribute(name: string, data: object): SchemaBuilder;
  addIndex(name: string, partitionKey: object, sortKey: object): SchemaBuilder;
  addReference(referenceType: string, entityName: string, sortKeys?: string[]): SchemaBuilder;
  allowRemove(allow: boolean): SchemaBuilder;
  allowUpdate(allow: boolean): SchemaBuilder;
  build(): Schema;
  withPrimaryPartitionKeys(partitionKeys: string[]): SchemaBuilder
  withPrimarySortKeys(sortKeys: string[]): SchemaBuilder;
}
