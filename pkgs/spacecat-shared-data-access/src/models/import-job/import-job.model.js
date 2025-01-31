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

import BaseModel from '../base/base.model.js';

/**
 * ImportJob - A class representing an ImportJob entity.
 * Provides methods to access and manipulate ImportJob-specific data.
 *
 * @class ImportJob
 * @extends BaseModel
 */
class ImportJob extends BaseModel {
  /**
   * Import Job Status types.
   * Any changes to this object needs to be reflected in the index.d.ts file as well.
   */
  static ImportJobStatus = {
    RUNNING: 'RUNNING',
    COMPLETE: 'COMPLETE',
    FAILED: 'FAILED',
    STOPPED: 'STOPPED',
  };

  /**
   * ImportURL Status types.
   * Any changes to this object needs to be reflected in the index.d.ts file as well.
   */
  static ImportUrlStatus = {
    PENDING: 'PENDING',
    REDIRECT: 'REDIRECT',
    ...ImportJob.ImportJobStatus,
  };

  /**
   * Supported Import Options.
   */
  static ImportOptions = {
    ENABLE_JAVASCRIPT: 'enableJavascript',
    PAGE_LOAD_TIMEOUT: 'pageLoadTimeout',
  };

  // add your custom methods or overrides here
}

export default ImportJob;
