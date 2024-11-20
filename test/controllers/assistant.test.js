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
import { FirefallClient } from '@adobe/spacecat-shared-gpt-client';
import { use, expect } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import chaiAsPromised from 'chai-as-promised';
import AssistantController from '../../src/controllers/assistant.js';
import { commandConfig, STATUS } from '../../src/support/assistant-support.js';

use(sinonChai);
use(chaiAsPromised);

describe('AssistantController tests', () => {
  let sandbox;
  let baseContext;
  let assistantController;
  let mockAuth;
  const screenshot = 'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAApgAAAKYB3X3/OAAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAANCSURBVEiJtZZPbBtFFMZ/M7ubXdtdb1xSFyeilBapySVU8h8OoFaooFSqiihIVIpQBKci6KEg9Q6H9kovIHoCIVQJJCKE1ENFjnAgcaSGC6rEnxBwA04Tx43t2FnvDAfjkNibxgHxnWb2e/u992bee7tCa00YFsffekFY+nUzFtjW0LrvjRXrCDIAaPLlW0nHL0SsZtVoaF98mLrx3pdhOqLtYPHChahZcYYO7KvPFxvRl5XPp1sN3adWiD1ZAqD6XYK1b/dvE5IWryTt2udLFedwc1+9kLp+vbbpoDh+6TklxBeAi9TL0taeWpdmZzQDry0AcO+jQ12RyohqqoYoo8RDwJrU+qXkjWtfi8Xxt58BdQuwQs9qC/afLwCw8tnQbqYAPsgxE1S6F3EAIXux2oQFKm0ihMsOF71dHYx+f3NND68ghCu1YIoePPQN1pGRABkJ6Bus96CutRZMydTl+TvuiRW1m3n0eDl0vRPcEysqdXn+jsQPsrHMquGeXEaY4Yk4wxWcY5V/9scqOMOVUFthatyTy8QyqwZ+kDURKoMWxNKr2EeqVKcTNOajqKoBgOE28U4tdQl5p5bwCw7BWquaZSzAPlwjlithJtp3pTImSqQRrb2Z8PHGigD4RZuNX6JYj6wj7O4TFLbCO/Mn/m8R+h6rYSUb3ekokRY6f/YukArN979jcW+V/S8g0eT/N3VN3kTqWbQ428m9/8k0P/1aIhF36PccEl6EhOcAUCrXKZXXWS3XKd2vc/TRBG9O5ELC17MmWubD2nKhUKZa26Ba2+D3P+4/MNCFwg59oWVeYhkzgN/JDR8deKBoD7Y+ljEjGZ0sosXVTvbc6RHirr2reNy1OXd6pJsQ+gqjk8VWFYmHrwBzW/n+uMPFiRwHB2I7ih8ciHFxIkd/3Omk5tCDV1t+2nNu5sxxpDFNx+huNhVT3/zMDz8usXC3ddaHBj1GHj/As08fwTS7Kt1HBTmyN29vdwAw+/wbwLVOJ3uAD1wi/dUH7Qei66PfyuRj4Ik9is+hglfbkbfR3cnZm7chlUWLdwmprtCohX4HUtlOcQjLYCu+fzGJH2QRKvP3UNz8bWk1qMxjGTOMThZ3kvgLI5AzFfo379UAAAAASUVORK5CYII=';
  const { info, debug, error } = console;

  beforeEach(() => {
    sinon.restore();
    sandbox = sinon.createSandbox();

    mockAuth = {
      checkScopes: sandbox.stub().resolves(true),
    };

    baseContext = {
      log: {
        info: sandbox.stub().callsFake(info),
        debug,
        error: sandbox.stub().callsFake(error),
      },
      auth: mockAuth,
      params: {},
      data: {},
      pathInfo: {
        headers: {
          'x-gw-ims-org-id': 'testHeaderImsOrgId',
        },
      },
      attributes: {
        authInfo: {
          profile: {
            getName: () => 'testName',
            getImsOrgId: () => 'testImsOrgId',
            getImsUserId: () => 'testImsUserId',
          },
        },
      },
      env: {
        ASSISTANT_CONFIGURATION: JSON.stringify({
          IMS_CLIENT_ID: 'test_client_id',
          IMS_CLIENT_SECRET: 'ssshhhhh',
          IMS_CLIENT_CODE: 'big_long_string_of_testy_client_code',
        }),
      },
    };
    if (Math.random() > 0.7) {
      // Occasionally use the x-gw-ims-org-id instead.
      baseContext.attributes.authInfo.profile.getImsOrgId = () => undefined;
    }
    assistantController = AssistantController(baseContext);
  });

  const testParameterWithCommand = async (
    command,
    errorMessage,
    testData = {},
    errorCode = STATUS.BAD_REQUEST,
  ) => {
    const response = await assistantController.processImportAssistant(
      {
        ...baseContext,
        data: {
          ...testData,
          command,
        },
      },
    );
    expect(response).to.be.an.instanceOf(Response);
    expect(response.status).to.equal(errorCode);
    expect(response.headers.get('x-error')).to.equal(errorMessage);
  };

  describe('processImportAssistant parameters', () => {
    it('commandConfig completeness test', async () => {
      for (const config of Object.values(commandConfig)) {
        const { parameters, firefallArgs } = config;
        expect(parameters).to.be.an('array');
        expect(firefallArgs).to.not.be.undefined;
        expect(firefallArgs).to.be.an('object');
        const { llmModel } = firefallArgs;
        expect(llmModel).to.not.be.undefined;

        // If an image is required, the prompt and model should be set appropriately.
        if (parameters.includes('imageUrl')) {
          expect(parameters).to.include('prompt');
          expect(llmModel).to.equal('gpt-4-vision');
        }
      }
    });
    it('missing ASSISTANT_CONFIGURATION test', async () => {
      delete baseContext.env.ASSISTANT_CONFIGURATION;
      assistantController = AssistantController(baseContext);
      const response = await assistantController.processImportAssistant(baseContext);
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(STATUS.SYS_ERROR);
      expect(baseContext.log.error.getCall(0).args[0]).to.include('The Assistant Configuration is not defined.');
      expect(response.headers.get('x-error')).to.include('Assistant Configuration is not defined.');
    });
    it('Non parsable ASSISTANT_CONFIGURATION test', async () => {
      baseContext.env.ASSISTANT_CONFIGURATION = 'I am just a string, not JSON.';
      assistantController = AssistantController(baseContext);
      const response = await assistantController.processImportAssistant(baseContext);
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(STATUS.SYS_ERROR);
      expect(response.headers.get('x-error')).to.include('Could not parse the Assistant Configuration:');
      expect(baseContext.log.error.getCall(0).args[0]).to.include('Could not parse the Assistant Configuration:');
    });
    it('unauthorized api key test', async () => {
      baseContext.auth.checkScopes = sandbox.stub().throws(new Error('Kaboom'));
      const response = await assistantController.processImportAssistant(undefined);
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(STATUS.UNAUTHORIZED);
      expect(response.headers.get('x-error')).to.equal('Missing required scopes.');
      expect(baseContext.log.error.getCall(0).args[0]).to.include('Missing required scopes.');
    });
    it('undefined request test', async () => {
      const response = await assistantController.processImportAssistant(undefined);
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(STATUS.BAD_REQUEST);
      expect(response.headers.get('x-error')).to.equal('Invalid request: missing request context.');
      expect(baseContext.log.error.getCall(0).args[0]).to.include('Invalid request: missing request context.');
    });
    it('non-object request test', async () => {
      const response = await assistantController.processImportAssistant('string');
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(STATUS.BAD_REQUEST);
      expect(response.headers.get('x-error')).to.equal('Invalid request: missing request context.');
      expect(baseContext.log.error.getCall(0).args[0]).to.include('Invalid request: missing request context.');
    });
    it('missing data in request test', async () => {
      const datalessContext = { ...baseContext };
      delete datalessContext.data;
      const response = await assistantController.processImportAssistant(datalessContext);
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(STATUS.BAD_REQUEST);
      expect(response.headers.get('x-error')).to.equal('Invalid request: invalid request context format.');
    });
    it('missing attributes in request test', async () => {
      const datalessContext = { ...baseContext };
      delete datalessContext.attributes;
      const response = await assistantController.processImportAssistant(datalessContext);
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(STATUS.BAD_REQUEST);
      expect(response.headers.get('x-error')).to.equal('Invalid request: invalid request context format.');
    });
    it('missing imsOrgId test', async () => {
      baseContext.attributes.authInfo.profile.getImsOrgId = () => undefined;
      baseContext.pathInfo.headers['x-gw-ims-org-id'] = undefined;
      // Check client error - which means the imsOrgId is missing, but it will continue.
      await testParameterWithCommand(
        'findMainContent',
        'Invalid request: A valid ims-org-id is not associated with your api-key.',
        { prompt: 'nav and some text' },
        STATUS.UNAUTHORIZED,
      );
      expect(baseContext.log.error.getCall(0).args[0]).to.contain('Invalid request: A valid ims-org-id is not associated with your api-key.');
    });
    it('missing profile in request test', async () => {
      const noProfileContext = { ...baseContext };
      delete noProfileContext.attributes.authInfo.profile;
      const response = await assistantController.processImportAssistant(
        {
          ...noProfileContext,
          data: {
            command: 'findMainContent',
            prompt: 'nav and some text',
            options: {},
          },
        },
      );
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(500);
      expect(response.headers.get('x-error')).to.include('Error creating FirefallClient: Context param');
    });
    it('missing command test', async () => {
      const response = await assistantController.processImportAssistant({ ...baseContext });
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(STATUS.BAD_REQUEST);
      expect(response.headers.get('x-error')).to.equal('Invalid request: command is required.');
      expect(baseContext.log.error.getCall(0).args[0]).to.include('Invalid request: command is required.');
    });
    it('empty command test', async () => {
      const response = await assistantController.processImportAssistant({ ...baseContext, data: { command: '' } });
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(STATUS.BAD_REQUEST);
      expect(response.headers.get('x-error')).to.equal('Invalid request: command is required.');
    });
    it('invalid command test', async () => {
      const response = await assistantController.processImportAssistant({ ...baseContext, data: { command: 'test' } });
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(STATUS.BAD_REQUEST);
      expect(response.headers.get('x-error')).to.equal('Invalid request: command not implemented: test');
    });
    it('missing prompt test', async () => {
      for (const [command, config] of Object.entries(commandConfig)) {
        if (config.parameters.includes('prompt')) {
          // For Debugging: console.log(`Testing ${command} for missing prompt`);
          // eslint-disable-next-line no-await-in-loop
          await testParameterWithCommand(command, 'Invalid request: prompt is required.');
        }
      }
    });
    it('missing image URL test', async () => {
      for (const [command, config] of Object.entries(commandConfig)) {
        if (config.parameters.includes('imageUrl')) {
          // For Debugging: console.log(`Testing ${command} for missing imageUrl`);
          // eslint-disable-next-line no-await-in-loop
          await testParameterWithCommand(
            command,
            'Invalid request: Image url is required.',
            {
              prompt: 'nav ing',
            },
          );
        }
      }
    });
    it('should throw an invalid request error with nonsense image', async () => {
      // Exercise all conditions of `isBase64UrlImage()`
      for (const imageUrl of [
        'not an image',
        'data:image/still not an image',
        'data:image/still not an image=',
        'data:image/still not a base64 image',
      ]) {
        // eslint-disable-next-line no-await-in-loop
        const response = await assistantController.processImportAssistant(
          {
            ...baseContext,
            data: {
              command: 'findBlockSelectors',
              prompt: 'nav and some text',
              options: {
                imageUrl,
              },
            },
          },
        );
        expect(response).to.be.an.instanceOf(Response);
        expect(response.status).to.equal(STATUS.BAD_REQUEST);
        expect(response.headers.get('x-error'))
          .to
          .equal('Invalid request: Image url is not a base64 encoded image.');
      }
    });
    it('should pass validation but fail firefall client', async () => {
      const response = await assistantController.processImportAssistant(
        {
          ...baseContext,
          data: {
            command: 'findBlockCells',
            prompt: 'nav and some text',
            options: {
              imageUrl: `data:image/png;base64,${screenshot}`,
            },
          },
        },
      );
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(500);
      expect(response.headers.get('x-error')).to.include('Error creating FirefallClient: Context param');
    });
    it('should pass validation but fail completion fetch', async () => {
      // eslint-disable-next-line no-unused-vars
      sinon.stub(FirefallClient, 'createFrom').callsFake(() => ({ }));

      const response = await assistantController.processImportAssistant(
        {
          ...baseContext,
          data: {
            command: 'findBlockCells',
            prompt: 'nav and some text',
            options: {
              imageUrl: `data:image/png;base64,${screenshot}`,
            },
          },
        },
      );
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(500);
      expect(response.headers.get('x-error')).to.include('Error fetching completion:');
    });
    it('should succeed with no image url', async () => {
      sinon.stub(FirefallClient, 'createFrom').callsFake(() => ({
        fetchChatCompletion: () => Promise.resolve({
          choices: [{ message: { content: '.breadcrumbs, .footer, .header' } }],
        }),
      }));

      const response = await assistantController.processImportAssistant(
        {
          ...baseContext,
          data: {
            command: 'findRemovalSelectors',
            prompt: 'Find breadcrumb selector: {{{content}}}',
          },
        },
      );
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(STATUS.OK);
      expect(response.headers.get('x-error')).to.equal(null);
      const results = await response.json();
      expect(results).to.not.be.undefined;
      expect(results.choices).to.not.be.undefined;
      expect(results.choices).to.be.an('array').of.length(1);
      expect(results.choices[0].message).to.not.be.undefined;
      expect(results.choices[0].message.content).to.not.be.undefined;
      expect(results.choices[0].message.content).to.equal('.breadcrumbs, .footer, .header');
    });
    it('should succeed', async () => {
      sinon.stub(FirefallClient, 'createFrom').callsFake(() => ({
        fetchChatCompletion: () => Promise.resolve({
          choices: [{ message: { content: '.breadcrumbs, .footer, .header' } }],
        }),
      }));

      const response = await assistantController.processImportAssistant(
        {
          ...baseContext,
          data: {
            command: 'findMainContent',
            prompt: 'Analyze the provided HTML document to determine which element most likely represents the main content of the page and provide an appropriate CSS selector for this element. The main content of the page should not include any headers, footers, breadcrumbs or sidebars: {{{content}}}',
            options: {
              imageUrl: `data:image/png;base64,${screenshot}`,
            },
          },
        },
      );
      expect(response).to.be.an.instanceOf(Response);
      expect(response.status).to.equal(STATUS.OK);
      expect(response.headers.get('x-error')).to.equal(null);
      const results = await response.json();
      expect(results).to.not.be.undefined;
      expect(results.choices).to.not.be.undefined;
      expect(results.choices).to.be.an('array').of.length(1);
      expect(results.choices[0].message).to.not.be.undefined;
      expect(results.choices[0].message.content).to.not.be.undefined;
      expect(results.choices[0].message.content).to.equal('.breadcrumbs, .footer, .header');
    });
  });
});
