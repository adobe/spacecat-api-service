/*
 * Copyright 2025 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

class QueryRegistry {
  constructor() {
    const filename = fileURLToPath(import.meta.url);
    const dirname = path.dirname(filename);
    this.templatePath = path.join(dirname, 'channel-query.sql.tpl');
    this.template = null;
    this._loadPromise = null;
  }

  async loadTemplate() {
    if (!this._loadPromise) {
      this._loadPromise = fs.readFile(this.templatePath, 'utf-8').then((tpl) => {
        this.template = tpl;
        return tpl;
      });
    }
    return this._loadPromise;
  }

  async renderQuery(params) {
    if (!this.template) {
      await this.loadTemplate();
    }
    return this.template
      .replace(/{{siteId}}/g, params.siteKey)
      .replace(/{{year}}/g, params.year)
      .replace(/{{month}}/g, params.month)
      .replace(/{{week}}/g, params.week)
      .replace(/{{groupBy}}/g, params.groupBy)
      .replace(/{{dimensionColumns}}/g, params.dimensionColumns)
      .replace(/{{dimensionColumnsPrefixed}}/g, params.dimensionColumnsPrefixed)
      .replace(/{{tableName}}/g, params.tableName);
  }
}

export { QueryRegistry };
