require('dotenv').config();
const express = require('express');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
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

function postToSlack(webhookUrl, payload, res) {
  const body = JSON.stringify(payload);
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
        res.status(500).json({ error: `Slack responded with ${slackRes.statusCode}: ${data}` });
      }
    });
  });

  slackReq.on('error', (err) => res.status(500).json({ error: err.message }));
  slackReq.write(body);
  slackReq.end();
}

const NUMBER_EMOJIS = [':one:', ':two:', ':three:', ':four:', ':five:', ':six:', ':seven:', ':eight:', ':nine:'];

const CHANNELS = {
  dev:  process.env.SLACK_CHANNEL_DEV  || 'app-testing',
  prod: process.env.SLACK_CHANNEL_PROD || 'all-the-cookbook-club',
};

const polls = new Map();
const userNameCache = new Map();

async function getDisplayName(userId) {
  if (userNameCache.has(userId)) return userNameCache.get(userId);
  return new Promise((resolve) => {
    const options = {
      hostname: 'slack.com',
      path: `/api/users.info?user=${userId}`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    };
    const req = https.request(options, (slackRes) => {
      let data = '';
      slackRes.on('data', (chunk) => (data += chunk));
      slackRes.on('end', () => {
        try {
          const result = JSON.parse(data);
          const name = result.user?.profile?.display_name || result.user?.profile?.real_name || result.user?.name || 'Unknown';
          userNameCache.set(userId, name);
          resolve(name);
        } catch { resolve('Unknown'); }
      });
    });
    req.on('error', () => resolve('Unknown'));
    req.end();
  });
}

function slackApi(method, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const options = {
      hostname: 'slack.com',
      path: `/api/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (slackRes) => {
      let data = '';
      slackRes.on('data', (chunk) => (data += chunk));
      slackRes.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function buildPollBlocks(poll) {
  const voteCounts = new Array(poll.answers.length).fill(0);
  const voterNames = poll.answers.map(() => []);
  for (const vote of Object.values(poll.votes)) {
    voteCounts[vote.idx]++;
    voterNames[vote.idx].push(vote.name);
  }
  const totalVotes = Object.keys(poll.votes).length;
  const isExpired = new Date() > poll.deadline;

  const deadlineStr = poll.deadline.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });

  const optionBlocks = poll.answers.map((answer, i) => {
    const names = voterNames[i].length > 0 ? ` (${voterNames[i].join(', ')})` : '';
    return {
      type: 'section',
      block_id: `option_${i}`,
      text: {
        type: 'mrkdwn',
        text: `${NUMBER_EMOJIS[i]}  *${answer}*${voteCounts[i] > 0 ? `   ·   ${voteCounts[i]} vote${voteCounts[i] !== 1 ? 's' : ''}${names}` : ''}`,
      },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: 'Vote', emoji: false },
        value: String(i),
        action_id: `poll_vote_${i}`,
      },
    };
  });

  return [
    { type: 'header', text: { type: 'plain_text', text: '📊  Poll', emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: `<!channel>  *${poll.question}*` } },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `Posted by Alfred the Butler  ·  ${isExpired ? '~Closed~' : `Closes *${deadlineStr}*`}  ·  ${totalVotes} vote${totalVotes !== 1 ? 's' : ''}`,
      }],
    },
    { type: 'divider' },
    ...optionBlocks,
    { type: 'divider' },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '_Single choice · Responses are not anonymous_' }],
    },
  ];
}

app.post('/send-poll', async (req, res) => {
  const { question, answers, channel } = req.body;

  if (!question || !Array.isArray(answers) || answers.length < 2) {
    return res.status(400).json({ error: 'Missing question or answers (need at least 2).' });
  }
  if (answers.length > 9) {
    return res.status(400).json({ error: 'Max 9 answers.' });
  }
  if (!process.env.SLACK_BOT_TOKEN) {
    return res.status(500).json({ error: 'SLACK_BOT_TOKEN not set in .env.' });
  }

  const poll = {
    question,
    answers: answers.map((a) => a.trim()),
    deadline: new Date(Date.now() + 36 * 60 * 60 * 1000),
    votes: {},
  };

  try {
    const result = await slackApi('chat.postMessage', {
      channel: CHANNELS[channel === 'prod' ? 'prod' : 'dev'],
      blocks: buildPollBlocks(poll),
      text: poll.question,
    });

    if (!result.ok) return res.status(500).json({ error: result.error });

    polls.set(result.ts, poll);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/slack/interactions', async (req, res) => {
  res.status(200).send('');

  let payload;
  try { payload = JSON.parse(req.body.payload); } catch { return; }

  if (payload.type !== 'block_actions') return;

  const action = payload.actions?.[0];
  if (!action?.action_id.startsWith('poll_vote_')) return;

  const messageTs = payload.message.ts;
  const channelId = payload.channel.id;
  const userId = payload.user.id;
  const answerIdx = parseInt(action.value, 10);

  const poll = polls.get(messageTs);
  if (!poll || new Date() > poll.deadline) return;

  const userName = await getDisplayName(userId);
  poll.votes[userId] = { idx: answerIdx, name: userName };

  slackApi('chat.update', {
    channel: channelId,
    ts: messageTs,
    blocks: buildPollBlocks(poll),
    text: poll.question,
  });
});

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

  const webhookUrl = channel === 'prod' ? WEBHOOKS.prod : WEBHOOKS.dev;
  postToSlack(webhookUrl, payload, res);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Alfred is ready at http://localhost:${PORT}`));
