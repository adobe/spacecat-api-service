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

import { ImportJob } from '../../src/index.js';

const importJobs = [
  {
    importJobId: '021cbb7d-0772-45c6-967c-86a0a598b7dd',
    importQueueId: 'Q-123',
    hashedApiKey: 'some-key-1',
    baseURL: 'https://example-1.com/cars',
    startedAt: '2023-12-06T08:17:41.467Z',
    status: ImportJob.ImportJobStatus.RUNNING,
    initiatedBy: {
      apiKeyName: 'K-123',
    },
    options: {
      [ImportJob.ImportOptions.ENABLE_JAVASCRIPT]: true,
    },
    hasCustomImportJs: true,
    hasCustomHeaders: false,
  },
  {
    importJobId: '72113a4d-ca45-4c35-bd2e-29bb0ec03435',
    importQueueId: 'Q-321',
    hashedApiKey: 'some-key-1',
    baseURL: 'https://example-2.com/cars',
    startedAt: '2023-11-15T01:22:05.000Z',
    status: ImportJob.ImportJobStatus.FAILED,
    initiatedBy: {
      apiKeyName: 'K-321',
    },
    options: {
      [ImportJob.ImportOptions.ENABLE_JAVASCRIPT]: false,
    },
    hasCustomImportJs: false,
    hasCustomHeaders: true,
  },
  {
    importJobId: '78e1f8de-661a-418b-bd80-24589a10b5ce',
    importQueueId: 'Q-213',
    hashedApiKey: 'some-key-2',
    baseURL: 'https://example-3.com/',
    startedAt: '2023-11-15T03:46:40.000Z',
    endedAt: '2023-11-15T03:49:13.000Z',
    status: ImportJob.ImportJobStatus.COMPLETE,
    initiatedBy: {
      apiKeyName: 'K-322',
    },
    options: {
      [ImportJob.ImportOptions.ENABLE_JAVASCRIPT]: false,
    },
    hasCustomImportJs: false,
    hasCustomHeaders: true,
  },
];

export default importJobs;
