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

/* eslint-env mocha */

import { Response } from '@adobe/fetch';
import { use, expect } from 'chai';
import sinonChai from 'sinon-chai';
import chaiAsPromised from 'chai-as-promised';
import AssistantController from '../../src/controllers/assistant.js';

use(sinonChai);
use(chaiAsPromised);

describe('AssistantController tests', () => {
  let baseContext;
  let assistantController;

  beforeEach(() => {
    baseContext = {
      params: {},
      data: {},
    };
    assistantController = AssistantController(baseContext);
  });

  describe('processImportAssistant', () => {
    it('should throw a not implemented error', async () => {
      const response = await assistantController.processImportAssistant({ ...baseContext });
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(501);
    });
    it('should throw a not implemented error with invalid command', async () => {
      const response = await assistantController.processImportAssistant({ ...baseContext, data: { command: 'test' } });
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(501);
      expect(response.headers.get('x-error')).to.equal('Assistant command not implemented: test');
    });
  });
});
