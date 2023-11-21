# DynamoDB Sample Data Generator

## Overview
This project is a Node.js application designed to generate sample data for DynamoDB tables. It's particularly useful for testing and development purposes, creating realistic data patterns in a DynamoDB environment.

## Features
- Creates specified DynamoDB tables based on a predefined schema.
- Generates a configurable number of sites with unique identifiers.
- Randomly generates audit data for each site, with a flexible range of audits per site.
- Supports scenarios where a site may have zero or more audits.

## Prerequisites
- Node.js installed on your machine.
- A local DynamoDB instance running on port 8000.

## Installation
1. Clone the repository to your local machine.
2. Navigate to the project directory.
3. Run `npm install` to install the necessary dependencies.

## Usage
To generate sample data:

1. Ensure your AWS credentials are set up and the DynamoDB tables defined in your schema do not already exist in your AWS environment (the script will create them).
2. Modify the `schema.json` file to define the structure of your DynamoDB tables.
3. Run the script using Node.js:
   ```
   node src/generateSampleData.js
   ```

You can customize the number of sites and the range of audits per site by modifying the arguments in the `generateSampleData` function call within the script:

```javascript
generateSampleData(numberOfSites, maxAuditsPerSite)
```

- `numberOfSites`: Number of site items to create.
- `maxAuditsPerSite`: Maximum number of audits to generate for each site. The actual number of audits per site will be randomly chosen between 0 and this maximum.
