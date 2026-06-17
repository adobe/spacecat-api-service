---
name: diagnose-cwv
description: "Diagnose why CWV code patches are not being generated for a site, site ID, or opportunity."
---

# Diagnose CWV

Use this skill when the user asks why CWV code patches are not being generated
for a site, site ID, or opportunity.

## Arguments

Accept a site URL, site ID, opportunity ID, and optional environment (`dev` or
`prod`) from the user request. If none of those identifiers is present, ask for
one before running diagnostics.

## Workflow

Run the diagnostic script at
`~/projects/expsuccess/spacecat/scripts/cwv/diagnose-cwv-codefix.sh` with the
arguments provided by the user.

Before running, check that the required environment variables are set:

- `API_KEY` or `SESSION_TOKEN` must be set in the shell; if neither is set, ask
  the user to run `! export API_KEY=<key>;` before continuing
- For AWS log checks, `AWS_PROFILE` should be set

Run the script and analyze the output. The script checks these pipeline stages:

1. CWV opportunity exists
2. Suggestions exist with correct status
3. Mystique guidance generated (data.issues[].value populated)
4. Code patches generated (data.issues[].patchContent / isCodeChangeAvailable)
5. Feature flags enabled (cwv-auto-suggest, cwv-auto-fix)
6. S3 code repo available
7. Fix entities created
8. CloudWatch error logs

After the script runs, summarize the findings and identify the likely blocker.
Common issues:

- **No guidance**: cwv-auto-suggest not enabled, or Mystique failed to process
- **Guidance but no patches**: cwv-auto-fix not enabled, no code repo is in S3,
  or the Mystique code-fix task failed
- **Patches but no fix entities**: Mystique or autofix-worker did not create them
- **Fix entities in FAILED/ERROR**: Check Mystique or autofix-worker logs for
  the specific error

If the script is not available, replicate the checks manually using curl and jq
against the SpaceCat API.
