/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import { ctx } from './harness.js';
import { resetPostgres } from './seed.js';
import {
  resetSemrushMocks, setUmMockQuota, dumpUmMock, dumpPeMock,
} from './setup.js';
import serenityTests from '../shared/tests/serenity.js';

serenityTests(() => ctx.httpClient, resetPostgres, resetSemrushMocks, {
  // setUmMockQuota and dumpUmMock are both intentionally retained though no shared serenity test
  // consumes them today: the allocator's flag-ON IT went with SITES-49206, but the spacecat-shared
  // §10.5 metered-write change will re-meter a sub-workspace through the same `__quota` route and
  // assert the result via the UM dump. Only dumpPeMock has a live consumer now. See setup.js.
  setUmMockQuota,
  dumpUmMock,
  dumpPeMock,
});
