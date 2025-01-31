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

export function guardSet(
  propertyName: string,
  value: never,
  entityName: string,
  type?: string,
  nullable?: boolean,
): void;

export function guardAny(
  propertyName: string,
  value: never,
  entityName: string,
  nullable?: boolean,
): void;

export function guardBoolean(
  propertyName: string,
  value: never,
  entityName: string,
  nullable?: boolean,
): void;

export function guardEnum(
  propertyName: string,
  value: never,
  enumValues: string[],
  entityName: string,
  nullable?: boolean,
): void;

export function guardId(
  propertyName: string,
  value: never,
  entityName: string,
  nullable?: boolean,
): void;

export function guardMap(
  propertyName: string,
  value: never,
  entityName: string,
  nullable?: boolean,
): void;

export function guardNumber(
  propertyName: string,
  value: never,
  entityName: string,
  nullable?: boolean,
): void;

export function guardString(
  propertyName: string,
  value: never,
  entityName: string,
  nullable?: boolean,
): void;
