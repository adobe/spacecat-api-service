# Onboard Workflow Documentation

## Overview

The onboard workflow is a comprehensive automation system that handles the complete onboarding process for new sites in SpaceCat. It combines Slack command execution with AWS Step Functions to orchestrate a series of tasks including site setup, audit execution, and post-processing activities.

## Architecture

The workflow consists of several components:

1. **Slack Command** (`onboard.js`) - Initiates the onboarding process
2. **Step Functions State Machine** - Orchestrates the workflow execution
3. **Task Processor Jobs** - Handle specific post-onboarding tasks
4. **Lambda Functions** - Execute the task processor jobs

## Slack Command: `onboard site`

### Usage

```bash
# Single site onboarding
@spacecat onboard site {site} [imsOrgId] [profile] [workflowWaitTime]

# Batch onboarding with CSV file
@spacecat onboard site {profile}
```

### Parameters

- `site` (required): The site URL to onboard
- `imsOrgId` (optional): IMS Organization ID (defaults to `DEMO_IMS_ORG` environment variable)
- `profile` (optional): Profile name for configuration (defaults to 'demo')
- `workflowWaitTime` (optional): Custom wait time in seconds for the workflow

### Supported Profiles

The system supports multiple profiles defined in `static/onboard/profiles.json`:

- **default**: Full audit and import configuration
- **summit**: Summit-specific configuration
- **summit-lower-quality**: Reduced quality summit configuration
- **demo**: Minimal configuration for demonstration purposes

### Profile Structure

```json
{
  "audits": {
    "audit-type": {}
  },
  "imports": {
    "import-type": {
      "start-date": "2025-02-24",
      "end-date": "2025-03-02"
    }
  },
  "config": {},
  "integrations": {}
}
```

## Onboarding Process

### 1. Initial Validation

The command performs several validation checks:

- **URL Validation**: Ensures the provided site URL is valid
- **IMS Org ID Validation**: Validates the IMS Organization ID format
- **Live Agent Customer Check**: Prevents onboarding of Live Agent customer sites (if `LA_CUSTOMERS` environment variable is set)

### 2. Organization Management

- Checks if an organization with the provided IMS Org ID exists
- Creates a new organization if it doesn't exist
- Retrieves organization details from IMS if needed

### 3. Site Setup

- Checks if the site already exists in the system
- Creates a new site if it doesn't exist, determining the delivery type automatically
- Updates site configuration with enabled imports and audits based on the selected profile

### 4. Audit Execution

- Triggers audits for all enabled audit types in the profile
- Sends audit messages to the SQS queue for processing
- Provides real-time feedback via Slack messages

### 5. Step Functions Workflow Initiation

Creates task processor jobs and starts the Step Functions workflow:

```javascript
const workflowInput = {
  opportunityStatusJob,
  disableImportAndAuditJob,
  demoURLJob,
  workflowWaitTime: workflowWaitTime || env.WORKFLOW_WAIT_TIME_IN_SECONDS,
};
```

## Step Functions Workflow

The workflow orchestrates task processor jobs to complete the post processing activities by caling Task Processor lambda for each job.

## Environment Variables

The following environment variables are used by the onboard workflow:

- `ONBOARD_WORKFLOW_STATE_MACHINE_ARN`: ARN of the Step Functions state machine
- `WORKFLOW_WAIT_TIME_IN_SECONDS`: Default wait time between workflow steps
- `DEMO_IMS_ORG`: Default IMS Organization ID for demo sites
- `LA_CUSTOMERS`: Comma-separated list of Live Agent customer URLs
- `EXPERIENCE_URL`: Base URL for Experience Cloud (defaults to 'https://experience.adobe.com')

## Error Handling

### Slack Command Errors

- **Invalid URL**: Returns error and stops processing
- **Invalid IMS Org ID**: Returns error and stops processing
- **Live Agent Customer**: Returns warning and stops processing
- **Organization Creation Failure**: Returns error and stops processing
- **Site Creation Failure**: Returns error and stops processing
- **Profile Loading Failure**: Returns error and stops processing

### Workflow Errors

- **Step Functions Execution Failure**: Logs error and continues
- **Processor Job Failure**: Individual jobs handle their own errors
- **SQS Message Failure**: Retries with exponential backoff

## Monitoring and Logging

### Logging

The workflow provides comprehensive logging at each step:

- Site validation and creation
- Organization management
- Profile loading and configuration
- Audit triggering
- Workflow initiation
- Processor job execution

### Slack Notifications

Real-time notifications are sent to Slack throughout the process:

- Initial setup confirmation
- Progress updates
- Error notifications
- Completion status
- Demo URL availability

### Debug Steps

1. Check CloudWatch logs for detailed error information
2. Verify environment variables are correctly set
3. Test individual components in isolation
4. Review Step Functions execution history
5. Check SQS queue metrics and dead letter queues
