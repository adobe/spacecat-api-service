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

import AWSCostApiClient from '@adobe/spacecat-shared-aws-costusage-client';

export default async function triggerAudit(context) {
    const { log, sqs } = context;
    const { type, startDate, endDate} = context.data;

    log.info('Triggering audit');
    const cogsClient = AWSCostApiClient.createFrom(context);
    
    try {
        const response = await cogsClient.getCostUsageData(
            startDate, 
            endDate, 
            "MONTHLY", 
            ["UnblendedCost"], 
            [
                {"Key": "SERVICE", "Type": "DIMENSION"}, 
                {"Key": "Environment", "Type": "TAG"}
            ], 
            {
                "Tags": {
                    "Key": 'Adobe.ArchPath', 
                    "Values": ['EC.SpaceCat.Services'], 
                    "MatchOptions": ['EQUALS']
                }
            }
        );
        log.info(response);
        const message = {
            type,
            startDate,
            endDate,
            data: response
        };
        await sendMessage(sqs, message);

    } catch(err) {
        console.error(`received error ${err}`);
        return JSON.stringify({error: `${err}`})
    }
    
    return JSON.stringify({ok: `${response}`});
}