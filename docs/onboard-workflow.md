# SpaceCat Onboarding Workflow

## Overview

The SpaceCat onboarding workflow provides an efficient and scalable solution for onboarding new sites to the SpaceCat system. This architecture employs AWS Step Functions to orchestrate long-running processes while avoiding Lambda timeout limitations. The design follows a profile-driven approach that enables flexible configuration of imports and audits without requiring workflow changes.

## Architecture Components

### 1. Entry Point: Onboard.js

- Located at: `src/support/slack/commands/onboard.js`
- Serves as the central entry point for the onboarding process
- Responsibilities:
  - Validates site URL and IMS organization ID
  - Creates or retrieves the organization and site
  - Determines site delivery type
  - Loads the appropriate profile configuration
  - Enables imports and audits in the site configuration
  - Initiates direct imports for the site
  - Starts the Step Functions workflow for subsequent operations

### 2. Step Functions State Machine

- Defined in the spacecat-infrastructure repository
  - modules/step_functions/statemachine/onboard-workflow.js
- Orchestrates the workflow with the following key states:
  - Scrape: Executes site scraping
  - Batch Audits: Processes all audits defined in the profile
  - Disable Imports/Audits: Cleans up by disabling imports and audits
- Error handling states that send notifications on failures
- Each state invokes the workflow handler with appropriate command parameters

### 3. Workflow Handler

- Located at: `src/support/slack/commands/step_functions/workflow-handler.js`
- Provides a unified interface for workflow operations
- Supports the following commands:
  - `run-scrape`: Executes site scraping
  - `run-batch-audits`: Processes all audits defined in the profile
  - `disable-imports-audits`: Disables imports and audits at the end of the workflow
  - `notify`: Sends error notifications to Slack

### 4. Slack Integration

- Commands triggered via Slack interface
- Error notifications sent back to the originating Slack channel
- Consistent error formatting with clear indicators

## Workflow Sequence

1. **Initial Setup (Onboard.js)**:
   - User triggers onboarding via Slack command
   - Site and organization are created or validated
   - Profile configuration is loaded
   - Imports and audits are enabled in site configuration
   - Direct imports are initiated

2. **Step Functions Execution**:
   - Step Functions workflow is started with site information and profile details
   - Site scraping is executed
   - Batch audits are processed
   - Imports and audits are disabled at completion

3. **Error Handling**:
   - Failures at any step send error notifications to Slack
   - Workflow continues to cleanup phase even after non-critical failures
   - Critical failures transition to WorkflowFailed state

## Profile-Driven Configuration

The workflow uses profile-based configuration to determine which imports and audits to run:

```json
{
  "default": {
    "imports": {
      "ahrefs": {
        "startDate": "2023-01-01",
        "endDate": "2023-12-31"
      }
    },
    "audits": {
      "cwv": {},
      "404": {},
      "lhs-mobile": {}
    }
  }
}
```

Benefits of this approach:
- Add or remove import/audit types without changing workflow code
- Configure date ranges or other parameters per import type
- Create different profiles for different site categories

## Error Notification System

The workflow includes a focused error notification system:
- Error messages sent to Slack using the `:x:` emoji indicator
- Clear error context provided in messages
- Error details logged to CloudWatch for troubleshooting

## Implementation Best Practices

1. **Profile Configuration**:
   - Store profiles in `static/onboard/profiles.json`
   - Include proper date ranges for time-based imports
   - Document any special parameters needed for custom audit types

2. **Error Handling**:
   - Log detailed error information for debugging
   - Send clear error notifications to users
   - Consider recovery options for non-critical failures

3. **Monitoring**:
   - Use AWS CloudWatch for logs and metrics
   - Monitor Step Functions execution status
   - Track Lambda function performance

## Usage Example

To onboard a new site using the default profile:

```
@spacecat onboard site https://example.com 123456789@AdobeOrg default
```

To use a custom profile:

```
@spacecat onboard site https://example.com 123456789@AdobeOrg custom-profile
```

## Extending the Workflow

To add new audit or import types:

1. Add the new type to your profile configuration
2. No changes needed to the workflow definition or state machine 