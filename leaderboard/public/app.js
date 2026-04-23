const csvInput       = document.getElementById('csvInput');
const previewBtn     = document.getElementById('previewBtn');
const sendBtn        = document.getElementById('sendBtn');
const sendLabel      = document.getElementById('sendLabel');
const sendSpinner    = document.getElementById('sendSpinner');
const previewSection = document.getElementById('previewSection');
const previewTable   = document.getElementById('previewTable');
const toast          = document.getElementById('toast');
const pollQuestion   = document.getElementById('pollQuestion');
const pollAnswers    = document.getElementById('pollAnswers');
const pollBtn        = document.getElementById('pollBtn');
const pollLabel      = document.getElementById('pollLabel');
const pollSpinner    = document.getElementById('pollSpinner');

let toastTimer;

function showToast(msg, type = 'success') {
  clearTimeout(toastTimer);
  toast.textContent = msg;
  toast.className = `toast ${type}`;
  toast.hidden = false;
  toastTimer = setTimeout(() => (toast.hidden = true), 3500);
}

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  const delim = lines[0].includes('\t') ? '\t' : ',';
  return lines.map(line => {
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

function renderPreviewTable(rows) {
  if (rows.length < 2) return '<p style="color:var(--text-muted)">Not enough rows.</p>';

  const [headers, ...data] = rows;
  let html = '<table><thead><tr><th></th>';
  headers.forEach(h => (html += `<th>${escapeHtml(h)}</th>`));
  html += '</tr></thead><tbody>';

  const dishCol = headers.findIndex(h => /dish|week|cook/i.test(h));
  const nameCol = headers.findIndex(h => /name/i.test(h));
  if (dishCol !== -1) {
    data.sort((a, b) => {
      const diff = (parseFloat(b[dishCol]) || 0) - (parseFloat(a[dishCol]) || 0);
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
  data.forEach((row) => {
    const count = dishCol !== -1 ? parseFloat(row[dishCol]) : NaN;
    const emoji = !isNaN(count) && count >= 1 ? '🍳' : '😴';
    html += `<tr><td>${emoji}</td>`;
    headers.forEach((_, ci) => (html += `<td>${escapeHtml(row[ci] ?? '')}</td>`));
    html += '</tr>';
  });

  html += '</tbody></table>';
  return html;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

previewBtn.addEventListener('click', () => {
  const raw = csvInput.value.trim();
  if (!raw) { showToast('Paste some CSV first.', 'error'); return; }
  const rows = parseCSV(raw);
  previewTable.innerHTML = renderPreviewTable(rows);
  previewSection.hidden = false;
  previewSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

pollBtn.addEventListener('click', async () => {
  const channel = document.querySelector('input[name="channel"]:checked')?.value ?? 'dev';
  const question = pollQuestion.value.trim();
  const answers = pollAnswers.value.split(',').map(a => a.trim()).filter(Boolean);

  if (!question) { showToast('Enter a question.', 'error'); return; }
  if (answers.length < 2) { showToast('Enter at least 2 comma-separated answers.', 'error'); return; }
  if (answers.length > 9) { showToast('Max 9 answers.', 'error'); return; }

  pollBtn.disabled = true;
  pollLabel.hidden = true;
  pollSpinner.hidden = false;

  try {
    const res = await fetch('/send-poll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, answers, channel }),
    });

    const data = await res.json();

    if (res.ok && data.success) {
      showToast('✓ Poll posted to Slack!', 'success');
      pollQuestion.value = '';
      pollAnswers.value = '';
    } else {
      showToast(data.error ?? 'Something went wrong.', 'error');
    }
  } catch (err) {
    showToast('Network error — is the server running?', 'error');
  } finally {
    pollBtn.disabled = false;
    pollLabel.hidden = false;
    pollSpinner.hidden = true;
  }
});

sendBtn.addEventListener('click', async () => {
  const channel = document.querySelector('input[name="channel"]:checked')?.value ?? 'dev';
  const csv = csvInput.value.trim();

  if (!csv) { showToast('Paste some CSV data.', 'error'); return; }

  sendBtn.disabled = true;
  sendLabel.hidden = true;
  sendSpinner.hidden = false;

  try {
    const res = await fetch('/send-leaderboard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ csv, channel }),
    });

    const data = await res.json();

    if (res.ok && data.success) {
      showToast('✓ Leaderboard posted to Slack!', 'success');
    } else {
      showToast(data.error ?? 'Something went wrong.', 'error');
    }
  } catch (err) {
    showToast('Network error — is the server running?', 'error');
  } finally {
    sendBtn.disabled = false;
    sendLabel.hidden = false;
    sendSpinner.hidden = true;
  }
});
