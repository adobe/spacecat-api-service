Diagnose why CWV code patches are not being generated for a site.

Run the diagnostic script at `~/projects/expsuccess/spacecat/scripts/cwv/diagnose-cwv-codefix.sh` with the arguments provided by the user.

The user will provide one or more of: site URL, site ID, opportunity ID. They may also specify the environment (dev or prod).

Before running, check that the required environment variables are set:
- `API_KEY` or `SESSION_TOKEN` must be set in the shell (ask the user to run `! export API_KEY=<key>` if not set)
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

After the script runs, summarize the findings and identify the likely blocker. Common issues:
- **No guidance**: cwv-auto-suggest not enabled, or Mystique failed to process
- **Guidance but no patches**: cwv-auto-fix not enabled, or no code repo in S3, or Mystique code fix task failed
- **Patches but no fix entities**: Mystique or autofix-worker didn't create them
- **Fix entities in FAILED/ERROR**: Check Mystique or autofix-worker logs for the specific error

If the script is not available, replicate the checks manually using curl + jq against the SpaceCat API.

$ARGUMENTS
