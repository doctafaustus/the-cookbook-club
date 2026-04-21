require('dotenv').config();
const express = require('express');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const WEBHOOKS = {
  dev:  process.env.SLACK_WEBHOOK_URL_DEV,
  prod: process.env.SLACK_WEBHOOK_URL_PROD,
};

if (!WEBHOOKS.dev || !WEBHOOKS.prod) {
  console.error('Missing SLACK_WEBHOOK_URL_DEV or SLACK_WEBHOOK_URL_PROD in .env');
  process.exit(1);
}

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  const delim = lines[0].includes('\t') ? '\t' : ',';
  return lines.map((line) => {
    const row = [];
    let cell = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === delim && !inQuotes) {
        row.push(cell.trim());
        cell = '';
      } else {
        cell += ch;
      }
    }
    row.push(cell.trim());
    return row;
  });
}

function normalizeRows(rows) {
  const width = rows[0].length;
  return rows.map((row) => {
    if (row.length <= width)
      return [...row, ...Array(width - row.length).fill('')];
    // merge overflow cells back into the last column
    return [...row.slice(0, width - 1), row.slice(width - 1).join(', ')];
  });
}

function buildTable(rows) {
  rows = normalizeRows(rows);
  const colWidths = rows[0].map((_, ci) =>
    Math.max(...rows.map((r) => (r[ci] ?? '').length)),
  );
  const hr = '+-' + colWidths.map((w) => '-'.repeat(w)).join('-+-') + '-+';
  const fmt = (row) =>
    '| ' + row.map((c, i) => (c ?? '').padEnd(colWidths[i])).join(' | ') + ' |';

  const [head, ...body] = rows;
  return [hr, fmt(head), hr, ...body.map(fmt), hr].join('\n');
}

const ALFRED_LINES = [
  'Alfred, at your service. Your weekly cook log, served fresh. 🫡🎩',
];

app.post('/send-leaderboard', (req, res) => {
  const { csv, channel } = req.body;

  if (!csv) {
    return res.status(400).json({ error: 'Missing csv.' });
  }

  const rows = parseCSV(csv);
  if (rows.length < 2) {
    return res
      .status(400)
      .json({ error: 'CSV needs at least one header row and one data row.' });
  }

  const [headers, ...data] = rows;
  const dishCol = headers.findIndex((h) => /dish|week|cook/i.test(h));
  const nameCol = headers.findIndex((h) => /name/i.test(h));
  if (dishCol !== -1) {
    data.sort((a, b) => {
      const diff =
        (parseFloat(b[dishCol]) || 0) - (parseFloat(a[dishCol]) || 0);
      if (diff !== 0) return diff;
      if (nameCol !== -1) {
        const aIsBill = /^bill$/i.test((a[nameCol] || '').trim());
        const bIsBill = /^bill$/i.test((b[nameCol] || '').trim());
        if (aIsBill && !bIsBill) return 1;
        if (bIsBill && !aIsBill) return -1;
      }
      return 0;
    });
  }
  const decorated = data.map((row) => {
    const count = dishCol !== -1 ? parseFloat(row[dishCol]) : NaN;
    const emoji = !isNaN(count) && count >= 1 ? '🍳' : '😴';
    return [emoji, ...row];
  });
  const tableRows = [['', ...headers], ...decorated];
  const table = buildTable(tableRows);

  const date = new Date().toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
  const signoff = ALFRED_LINES[Math.floor(Math.random() * ALFRED_LINES.length)];
  const heading = 'The Cook Log';

  const payload = {
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `📋  ${heading}`, emoji: true },
      },
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: `*${date}*  ·  Posted by Alfred the Butler` },
        ],
      },
      { type: 'divider' },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '```\n' + table + '\n```' },
      },
      { type: 'divider' },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `_${signoff}_` },
      },
    ],
  };

  const body = JSON.stringify(payload);
  const webhookUrl = channel === 'prod' ? WEBHOOKS.prod : WEBHOOKS.dev;
  let parsedUrl;
  try {
    parsedUrl = new URL(webhookUrl);
  } catch {
    return res.status(500).json({ error: 'Webhook URL in .env is invalid.' });
  }

  const options = {
    hostname: parsedUrl.hostname,
    path: parsedUrl.pathname + parsedUrl.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  };

  const lib = parsedUrl.protocol === 'https:' ? https : http;
  const slackReq = lib.request(options, (slackRes) => {
    let data = '';
    slackRes.on('data', (chunk) => (data += chunk));
    slackRes.on('end', () => {
      if (slackRes.statusCode === 200) {
        res.json({ success: true });
      } else {
        res.status(500).json({
          error: `Slack responded with ${slackRes.statusCode}: ${data}`,
        });
      }
    });
  });

  slackReq.on('error', (err) => res.status(500).json({ error: err.message }));
  slackReq.write(body);
  slackReq.end();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Alfred is ready at http://localhost:${PORT}`));
