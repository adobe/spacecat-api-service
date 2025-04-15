import { isValidUrl, isNonEmptyArray } from '@adobe/spacecat-shared-utils';
import {
    postErrorMessage,
    parseCSV,
} from '../../../utils/slack/base.js';
import BaseCommand from './base.js';

//import runScrape from './run-scrape.js';
//import runAudit from './run-audit.js';
//import runImport from './run-import.js';
import Onboard from './onboard.js';

const PHRASES = ['run workflow site', 'run workflow sites'];

function RunWorkflowCommand(context) {
    const baseCommand = BaseCommand({
        id: 'onboard-workflow',
        name: 'Onboard Workflow',
        description: 'Runs full onboarding, scrape, audit, and import for a site or list of sites.',
        phrases: PHRASES,
        usageText: `${PHRASES[0]} {siteURL} {imsOrgId} {profile} {importType} {startDate} {endDate}`,
    });

    const { log } = context;

    const onboard = Onboard(context);
    //const scrape = runScrape(context);
    //const audit = runAudit(context);
    //const imprt = runImport(context);

    const runWorkflowForSite = async(
        siteUrl,
        imsOrgId,
        profile,
        //importType,
        //startDate,
        //endDate,
        slackContext
    ) => {
        const logStep = (msg) => {
            log.info(msg);
            slackContext.say?.(`${msg}`);
        };

        try {
            logStep(`Starting onboarding for ${siteUrl}`);
            try {
                await onboard.handleExecution([siteUrl, imsOrgId, profile], slackContext);
            } catch (err) {
                log.error("Can not call handleExecution from onboard command", err);
            }

            //logStep(`Running scrape for ${siteUrl}`);
            //await scrape.handleExecution([siteUrl], slackContext);

            //logStep(`Running audit (lhs-mobile) for ${siteUrl}`);
            //await audit.handleExecution([siteUrl, 'lhs-mobile'], slackContext);

            //logStep(`Running import (${importType}) for ${siteUrl}`);
            //await imprt.handleExecution([importType, siteUrl, startDate, endDate], slackContext);

            logStep(`Completed full workflow for ${siteUrl}`);
        } catch (error) {
            log.error(error);
            await postErrorMessage(slackContext.say, error);
        }
    };

    const handleExecution = async (args, slackContext) => {
        const { say, files, botToken } = slackContext;

        try {
            const [siteUrlOrImportType, imsOrgId, profile, importTypeArg, startDateArg, endDateArg] = args;

            const hasCSV = isNonEmptyArray(files);
            const isSingleSite = isValidUrl(siteUrlOrImportType);

            if (!isSingleSite && !hasCSV) {
                await say(baseCommand.usage());
                return;
            }

            if (isSingleSite && hasCSV) {
                await say(':warning: Provide either a URL or a CSV file, not both.');
                return;
            }

            const startDate = startDateArg || null;
            const endDate = endDateArg || null;

            await runWorkflowForSite(siteUrlOrImportType, imsOrgId, profile, slackContext);

            /**
            if (isSingleSite) {
                const siteURL = siteUrlOrImportType;
                const importType = importTypeArg;

                await runWorkflowForSite(siteURL, imsOrgId, profile, importType, startDate, endDate, slackContext);
            } else if (hasCSV) {
                const file = files[0];
                if (!file.name.endsWith('.csv')) {
                    await say(':warning: Please upload a valid CSV file.');
                    return;
                }

                const csvData = await parseCSV(file, botToken);
                say(`:adobe-run: Starting full workflow for ${csvData.length} sites...`);

                await Promise.all(
                    csvData.map(async ([url, orgId, profileName, importType, startDate, endDate]) => {
                        if (isValidUrl(url)) {
                            await runWorkflowForSite(url, orgId, profileName, importType, startDate, endDate, slackContext);
                        } else {
                            await say(`:warning: Invalid URL in CSV: ${url}`);
                        }
                    })
                );
            } */
        } catch (error) {
            log.error(error);
            await postErrorMessage(slackContext.say, error);
        }
    };

    baseCommand.init(context);

    return {
        ...baseCommand,
        handleExecution,
    };
}

export default RunWorkflowCommand;
