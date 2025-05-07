# OpenPhone to SalesNexus Integration

This integration connects OpenPhone's call recording, transcript, and summary webhooks to SalesNexus, automatically creating notes in the appropriate contact records.

## Features

- Receives webhooks from OpenPhone containing call recordings, transcripts, and summaries
- Uses a phone number to email mapping system to find the correct contact in SalesNexus
- Creates detailed notes in SalesNexus with recording links, summaries, and transcripts
- Provides a web interface for managing phone number to email mappings

## Setup Instructions

### 1. Configure Firebase (for Phone-Email Mappings)

1. Create a new Firebase project at [console.firebase.google.com](https://console.firebase.google.com/)
2. Set up a Firestore database
3. Generate a Service Account key:
   - Go to Project Settings > Service Accounts
   - Click "Generate new private key"
   - Save the JSON file

4. Add the Firebase configuration to your Netlify environment variables:
   - In Netlify, go to Site settings > Environment variables
   - Add the following variables from your Firebase project:
     - `FIREBASE_API_KEY`
     - `FIREBASE_AUTH_DOMAIN`
     - `FIREBASE_PROJECT_ID`
     - `FIREBASE_STORAGE_BUCKET`
     - `FIREBASE_MESSAGING_SENDER_ID`
     - `FIREBASE_APP_ID`
   - Add another environment variable called `FIREBASE_SERVICE_ACCOUNT`
     - Paste the entire content of the service account JSON file here

### 2. Configure SalesNexus Connection

Add these environment variables in Netlify:
- `SALESNEXUS_API_KEY`: Your SalesNexus API key
- `FALLBACK_CONTACT_ID`: The ID of the contact to use when no mapping is found

### 3. Configure Webhook URL in OpenPhone

1. In OpenPhone, go to Settings > Integrations
2. Add a new webhook
3. Enter your Netlify webhook URL: `https://your-netlify-app.netlify.app/.netlify/functions/webhook`
4. Select the following event types:
   - Call Recording Completed
   - Call Transcript Completed
   - Call Summary Completed

### 4. Set up Phone-Email Mappings

1. Visit your mapping interface at `https://your-netlify-app.netlify.app/`
2. Import your existing contacts via CSV
3. Add new mappings as needed

## How It Works

1. When a call ends, OpenPhone sends webhooks with the recording, transcript, and summary to your Netlify function
2. The webhook handler extracts the phone number from the webhook
3. It looks up the email associated with that phone number in the Firebase database
4. It searches SalesNexus for a contact with that email
5. It creates a note in the found contact's record with the call information

## Maintenance Notes

- Once SalesNexus implements phone number search in their API, this integration can be updated to use that feature directly
- For security purposes, consider implementing authentication on the mapping interface in production

## Troubleshooting

Check the function logs in Netlify to diagnose any issues:
1. Go to your site in Netlify
2. Click on Functions
3. Find the webhook or mapping function
4. View the logs for detailed information about any errors
