# SpaceCat Onboard Workflow

## Overview

The onboard workflow architecture solves the scalability limitations of the previous design. Instead of defining individual steps for each import and audit type in the Step Functions workflow, this implementation uses batch processing to handle multiple imports and audits through profile-driven configuration. The recent changes further streamline the flow by consolidating functionality in onboard.js and integrating automatic cleanup at the end of the workflow.

## Key Benefits

1. **Scalability**: Adding new import or audit types to profiles doesn't require workflow changes
2. **Maintainability**: Fewer states in the Step Functions workflow means easier maintenance
3. **Flexibility**: Profile-driven configuration simplifies customization
4. **Efficiency**: Batch processing reduces Lambda invocations
5. **Unified Command Handling**: All workflow commands are now processed through a single Lambda handler
6. **Simplified Architecture**: Removed unnecessary components and redundant checks
7. **Automatic Cleanup**: Disables imports and audits at the end of the workflow
8. **Clear Responsibility Boundaries**: Separation between initial setup (onboard.js) and workflow execution (step_functions)

## Architecture Components

### 1. Step Functions Workflow Definition

- Located at: `/modules/step_functions/templates/onboard-workflow.json`
- Simplified to three main steps: Batch Imports, Scrape, and Batch Audits, plus Disable Imports/Audits
- Each step invokes the `workflow-handler` Lambda with different command parameters
- Onboarding happens before Step Functions, directly in onboard.js

### 2. Workflow Handler Lambda

- Located at: `src/support/slack/commands/step_functions/workflow-handler.js` (renamed from lambda to step_functions)
- Handles workflow commands:
  - `run-scrape`: Directly executes the scrape command
  - `run-batch-imports`: Processes all imports defined in the profile
  - `run-batch-audits`: Processes all audits defined in the profile
  - `disable-imports-audits`: Disables imports and audits at the end of the workflow
  - `notify`: Sends Slack notifications at various workflow stages

### 3. Onboard.js

- Located at: `src/support/slack/commands/onboard.js`
- Now serves as the central entry point for onboarding
- Handles site creation, validation, and enabling imports/audits
- Starts the Step Functions workflow

### 4. Slack Integration

- Workflow execution is triggered via Slack commands
- Command parameters are passed to Step Functions
- Status updates are sent to Slack throughout the workflow
- Simplified notifications using emoji-based status indicators

## Implementation Details

### Command Processing Flow

1. User enters a Slack command for onboarding
2. The command is routed to `onboard.js`
3. `onboard.js` creates/validates the site, enables imports/audits, and starts the Step Functions workflow
4. Step Functions runs batch imports, scrape, and batch audits
5. Step Functions automatically disables imports and audits at workflow completion
6. Notifications are sent to Slack at each step

### Profile-Driven Configuration

Profiles define which imports and audits to run for each site:

```json
{
  "default": {
    "imports": {
      "ahrefs": {}
    },
    "audits": {
      "cwv": {},
      "404": {}
    }
  }
}
```

## Key Files

1. **onboard.js**: Central entry point for starting the onboarding process
2. **workflow-handler.js**: Handler for workflow commands
3. **onboard-workflow.json**: Step Functions state machine definition
4. **onboard_workflow.tf**: Terraform configuration for Step Functions

## Monitoring and Management

- CloudWatch logs for Lambda functions and Step Functions
- Slack notifications for workflow status
- Step Functions visualization for workflow execution tracking

## Workflow Steps

1. **Onboard Site**: Handled directly by onboard.js (before Step Functions)
2. **Batch Imports**: Process all imports defined in the profile
3. **Scrape**: Execute site scrape
4. **Batch Audits**: Process all audits defined in the profile
5. **Disable Imports/Audits**: Clean up by disabling imports and audits

## Error Handling

Each step includes error handling and notification:

- Failed steps direct to WorkflowFailed instead of continuing
- Error messages are sent to Slack with appropriate emoji indicators
- The final disable-imports-audits step runs even after audit failures

## Implementation Files

- `src/support/slack/commands/step_functions/workflow-handler.js`: Handles workflow steps
- `src/support/slack/commands/onboard.js`: Handles onboarding and workflow initiation

## Usage

To start an onboarding process, use the Slack command:

```
@spacecat run onboard https://example.com 123456789@AdobeOrg default
```

## Adding New Import/Audit Types

To add new import or audit types:

1. Update the profile configuration in `static/onboard/profiles.json`
2. No changes to the workflow definition required!

Example profile update:

```json
{
  "default": {
    "imports": {
      "organic-traffic": {},
      "top-pages": {},
      "all-traffic": {},
      "new-import-type": {}
    },
    "audits": {
      "cwv": {},
      "404": {},
      "new-audit-type": {}
    }
  }
}
``` 