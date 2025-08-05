# Gmail Alert Processor

This application automatically processes Gmail alerts for 4xx, 5xx, and TargetResponseTime issues, downloads relevant logs from S3, and generates analysis reports.

## Features

- Automatically fetches alerts from Gmail
- Processes multiple types of alerts:
  - 4xx errors
  - 5xx errors
  - Target Response Time alerts
- Downloads relevant logs from AWS S3
- Generates detailed analysis reports
- Creates zip archives of results

## Setup

1. Install dependencies:
```bash
npm install
```

2. Set up Google Cloud credentials:
- Create a project in Google Cloud Console
- Enable Gmail API
- Create OAuth 2.0 credentials
- Download and save as `credentials.json`

3. Configure AWS credentials:
- Ensure AWS CLI is configured with appropriate credentials
- Use profile 'sportz' or modify in code

4. Set up client mappings:
- Edit `clientMap.json` with appropriate S3 paths

## Usage

Run the application:
```bash
node main.js
```

## Output

The application creates:
- Analysis files for each alert
- Zip archives containing:
  - Raw logs
  - URL lists
  - High response time reports
