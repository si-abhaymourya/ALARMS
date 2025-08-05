const fs = require('fs').promises;
const path = require('path');
const process = require('process');
const {authenticate} = require('@google-cloud/local-auth');
const {google} = require('googleapis');

// If modifying these scopes, delete token.json.
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const TOKEN_PATH = path.join(process.cwd(), 'token.json');
const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');

async function loadSavedCredentialsIfExist() {
  try {
    const content = await fs.readFile(TOKEN_PATH);
    const credentials = JSON.parse(content);
    return google.auth.fromJSON(credentials);
  } catch (err) {
    return null;
  }
}

async function saveCredentials(client) {
  const content = await fs.readFile(CREDENTIALS_PATH);
  const keys = JSON.parse(content);
  const key = keys.installed || keys.web;
  const payload = {
    type: 'authorized_user',
    client_id: key.client_id,
    client_secret: key.client_secret,
    refresh_token: client.credentials.refresh_token,
  };
  await fs.writeFile(TOKEN_PATH, JSON.stringify(payload));
}

async function authorize() {
  let client = await loadSavedCredentialsIfExist();
  if (client) {
    return client;
  }
  client = await authenticate({
    scopes: SCOPES,
    keyfilePath: CREDENTIALS_PATH,
  });
  if (client.credentials) {
    await saveCredentials(client);
  }
  return client;
}

function normalizeFrom(fromStr) {
  if (!fromStr) return "";
  // Try to extract email inside <>
  const m = fromStr.match(/<([^>]+)>/);
  const email = m ? m[1] : fromStr;
  return email.trim().toLowerCase();
}

async function getEmails(auth) {
  // First, clear the existing alert.json by writing an empty array
  try {
    await fs.writeFile('alert.json', JSON.stringify([], null, 2));
    console.log('Cleared existing alert.json');
  } catch (err) {
    console.log('No existing alert.json found, will create new');
  }

  const gmail = google.gmail({version: 'v1', auth});
  const keywords = ["4xx", "5xx", "TargetResponseTime"];
  const results = [];

  // Calculate date for 10 days ago (matching your Apps Script)
  const afterDate = new Date();
  afterDate.setDate(afterDate.getDate() - 10);
  const query = `after:${formatDate(afterDate)}`;

  try {
    // Get list of message threads
    const res = await gmail.users.threads.list({
      userId: 'me',
      q: query,
    });

    const threads = res.data.threads || [];

    try {
      // Process each thread
      for (const thread of threads) {
        try {
          // Get full thread with messages
          const threadData = await gmail.users.threads.get({
            userId: 'me',
            id: thread.id,
            format: 'full'
          });

          const messages = threadData.data.messages || [];
          if (messages.length === 0) continue;

          // Get original sender from first message
          const firstMsg = messages[0];
          const originalFromNorm = normalizeFrom(getHeader(firstMsg.payload.headers, 'From'));

      // Process each message in thread
      for (const message of messages) {
        try {
          const subject = getHeader(message.payload.headers, 'Subject').toLowerCase();
          const from = getHeader(message.payload.headers, 'From');
          const thisFromNorm = normalizeFrom(from);
          const date = new Date(parseInt(message.internalDate));
          
          // Get message body
          let body = '';
          if (message.payload.body.data) {
            body = Buffer.from(message.payload.body.data, 'base64').toString();
          } else if (message.payload.parts) {
            // Handle multipart messages
            const textPart = message.payload.parts.find(part => part.mimeType === 'text/plain');
            if (textPart && textPart.body.data) {
              body = Buffer.from(textPart.body.data, 'base64').toString();
            }
          }

          // Check if this is a reply from someone other than original sender
          const isReplyFromOther = thisFromNorm !== originalFromNorm;

          // Extract UTC time if present
          let utcTimeMatch = body.match(/at\s+"[^"]*?(\d{2}:\d{2}:\d{2})\s*UTC"/);
          let utcTime = utcTimeMatch ? utcTimeMatch[1] : "";

          // Check if subject or body contains any keywords
          for (const keyword of keywords) {
            const kw = keyword.toLowerCase();
            if (subject.includes(kw) || body.toLowerCase().includes(kw)) {
              results.push({
                alarm_type: keyword,
                scripts_to_run: keyword.toLowerCase(),
                subject: getHeader(message.payload.headers, 'Subject'),
                from: from,
                date: date.toISOString().split('T')[0], // Date only
                utc_time: utcTime,
                ignore: isReplyFromOther
              });
              break;
            }
          }
        } catch (err) {
          console.error('Error processing message:', err);
          continue;
        }
      }
    } catch (err) {
      console.error('Error processing thread:', err);
      continue;
    }
  }
} catch (err) {
  console.error('Error fetching threads:', err);
  throw err;
}
    // Write results to alert.json
    await fs.writeFile('alert.json', JSON.stringify(results, null, 2));
    console.log('Alerts saved to alert.json');
    return results;

  } catch (err) {
    console.error('Error fetching emails:', err);
    throw err;
  }
}

function getHeader(headers, name) {
  const header = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
  return header ? header.value : '';
}

function formatDate(date) {
  const year = date.getFullYear();
  const month = (`0${date.getMonth() + 1}`).slice(-2);
  const day = (`0${date.getDate()}`).slice(-2);
  return `${year}/${month}/${day}`;
}

module.exports = {
  authorize,
  getEmails
};