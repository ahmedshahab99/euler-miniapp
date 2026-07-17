const tg = window.Telegram?.WebApp;
let userData = null;
let isPremium = false;
let downloadHistory = [];
let adShown = false;
let selectedFormat = null;
let currentFormats = null;
let pollTimer = null;
let currentTaskId = null;

function init() {
  console.log('[MiniApp] init called, tg:', !!tg);
  if (tg) {
    tg.ready();
    tg.expand();
    tg.setHeaderColor('#0a0a0f');
    tg.setBackgroundColor('#0a0a0f');
    try { userData = tg.initDataUnsafe?.user; } catch (e) {}
  }

  // Check if opened with ?url= param (from bot ad flow)
  const params = new URLSearchParams(window.location.search);
  const pendingUrl = params.get('url');
  console.log('[MiniApp] URL params:', window.location.search, 'pendingUrl:', pendingUrl);
  if (pendingUrl) {
    console.log('[MiniApp] Calling showInterstitialAdMode');
    showInterstitialAdMode(pendingUrl);
    return;
  }

  // Normal mode
  const input = document.getElementById('url-input');
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') startDownload(); });

  if (navigator.clipboard) {
    navigator.clipboard.readText().then(text => {
      if (text && text.match(/^https?:\/\//)) {
        input.value = text;
        showToast('URL pasted from clipboard');
      }
    }).catch(() => {});
  }

  loadHistory();
  checkPremium();
  renderHistory();
}

// === INTERSTITIAL AD MODE (opened from bot with ?url=) ===
function showInterstitialAdMode(url) {
  document.getElementById('app').innerHTML = '';

  const overlay = document.createElement('div');
  overlay.className = 'interstitial-overlay';
  overlay.innerHTML = `
    <div class="interstitial-wrapper">
      <div class="interstitial-header">
        <span class="interstitial-badge">AD</span>
        <span class="interstitial-brand">A-Ads Network</span>
      </div>
      <div class="interstitial-ad-area">
        <iframe data-aa='2445630' src='//acceptable.a-ads.com/2445630/?size=Adaptive'
          style='border:0; padding:0; width:100%; max-width:400px; height:auto; min-height:250px; overflow:hidden; display:block; margin:auto'></iframe>
      </div>
      <div class="interstitial-footer">
        <div class="interstitial-progress">
          <div class="interstitial-bar" id="int-bar"></div>
        </div>
        <div class="interstitial-text" id="int-text">Please wait <span id="int-countdown">5</span>s...</div>
        <button class="btn-continue hidden" id="btn-continue" onclick="continueToBot('${encodeURIComponent(url)}')">Continue to Download</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  let countdown = 5;
  const countdownEl = document.getElementById('int-countdown');
  const textEl = document.getElementById('int-text');
  const barEl = document.getElementById('int-bar');
  const continueBtn = document.getElementById('btn-continue');

  const interval = setInterval(() => {
    countdown--;
    if (countdownEl) countdownEl.textContent = countdown;
    if (barEl) barEl.style.width = ((5 - countdown) / 5 * 100) + '%';
    if (countdown <= 0) {
      clearInterval(interval);
      if (textEl) textEl.innerHTML = '<span style="color:var(--success)">&#10003; Ad complete!</span>';
      if (continueBtn) continueBtn.classList.remove('hidden');
      // Auto-continue so the download starts even if the button is unreachable
      // (e.g. clipped on small screens). The guard in continueToBot prevents
      // a double trigger if the user also taps the button.
      setTimeout(() => continueToBot(encodeURIComponent(url)), 700);
    }
  }, 1000);
}

function continueToBot(encodedUrl) {
  if (window.__adCompleted) return;
  window.__adCompleted = true;
  const url = decodeURIComponent(encodedUrl);
  console.log('[MiniApp] continueToBot called, url:', url, 'tg:', !!tg);

  // Primary path: POST to the bot's /api/webapp-complete endpoint (same
  // origin). This is the verified-working flow: the server downloads and
  // uploads the result to the chat. tg.sendData is only used as a fallback
  // if the fetch fails, because in some clients sendData silently does
  // nothing (no error thrown), which would leave the button stuck.
  const initData = (tg && tg.initData) ? tg.initData : '';
  fetch('/api/webapp-complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, init_data: initData })
  })
  .then(res => res.json())
  .then(data => {
    console.log('[MiniApp] API response:', data);
    showToast(data.message || 'Download started');
    setTimeout(() => { try { tg.close(); } catch (e) {} }, 700);
  })
  .catch(err => {
    console.error('[MiniApp] fetch failed, trying sendData:', err);
    if (tg && typeof tg.sendData === 'function') {
      try { tg.sendData(url); } catch (e) { console.error('[MiniApp] sendData error', e); }
    }
    showToast('Starting download...');
    setTimeout(() => { try { tg.close(); } catch (e) {} }, 700);
  });
}

// === NORMAL MODE ===
function startDownload() {
  const input = document.getElementById('url-input');
  const url = input.value.trim();
  if (!url) { showToast('Please enter a URL'); input.focus(); return; }
  if (!url.match(/^https?:\/\//)) { showToast('Please enter a valid URL'); return; }

  if (!isPremium && !adShown) {
    showInlineAd(url);
    return;
  }

  adShown = false;
  beginExtraction(url);
}

function showInlineAd(url) {
  const banner = document.getElementById('ad-banner');
  banner.classList.remove('hidden');

  let countdown = 5;
  const countdownEl = document.getElementById('ad-countdown');
  const timerEl = document.getElementById('ad-timer');
  const skipBtn = document.getElementById('btn-skip-ad');

  skipBtn.classList.add('hidden');
  timerEl.classList.remove('hidden');

  const interval = setInterval(() => {
    countdown--;
    countdownEl.textContent = countdown;
    if (countdown <= 0) {
      clearInterval(interval);
      timerEl.classList.add('hidden');
      skipBtn.classList.remove('hidden');
      window._pendingUrl = url;
    }
  }, 1000);
}

function skipAd() {
  document.getElementById('ad-banner').classList.add('hidden');
  adShown = true;
  if (window._pendingUrl) {
    beginExtraction(window._pendingUrl);
    window._pendingUrl = null;
  }
}

async function beginExtraction(url) {
  showProgress('Processing...', 'Extracting video info');
  hideFormats();

  try {
    const resp = await fetch('/api/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, user_id: userData?.id || 0 })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Extraction failed');
    currentTaskId = data.task_id;
    currentFormats = data;
    showFormats(data);
    hideProgress();
  } catch (e) {
    hideProgress();
    showToast('Error: ' + e.message);
    addToHistory(url, 'error', 'Failed');
  }
}

function showFormats(data) {
  const section = document.getElementById('formats-section');
  const info = document.getElementById('video-info');
  const list = document.getElementById('formats-list');

  info.innerHTML = `
    <div class="video-info-title">${escapeHtml(data.title || 'Unknown')}</div>
    <div class="video-info-meta">${escapeHtml(data.extractor || '')} — ${(data.formats || []).length} formats available</div>
  `;

  const formats = data.formats || [];
  const videoFormats = formats.filter(f => f.height && !f.audio_only).sort((a, b) => (b.height || 0) - (a.height || 0));
  const audioFormats = formats.filter(f => f.audio_only || f.vcodec === 'none');

  list.innerHTML = '';
  const quickOptions = [
    { label: 'Best Quality', detail: 'Highest available', format: videoFormats[0] },
    { label: 'HD 1080p', detail: '1080p', format: videoFormats.find(f => f.height === 1080) },
    { label: 'HD 720p', detail: '720p', format: videoFormats.find(f => f.height === 720) },
    { label: 'SD 480p', detail: '480p', format: videoFormats.find(f => f.height === 480) },
    { label: 'Audio Only', detail: 'MP3/M4A', format: audioFormats[0] },
  ].filter(o => o.format);

  quickOptions.forEach((opt, i) => {
    const item = document.createElement('div');
    item.className = 'format-item' + (i === 0 ? ' selected' : '');
    const height = opt.format.height || 0;
    let badge = '';
    if (height >= 2160) badge = '<span class="format-badge badge-4k">4K</span>';
    else if (height >= 1080) badge = '<span class="format-badge badge-fhd">FHD</span>';
    else if (height >= 720) badge = '<span class="format-badge badge-hd">HD</span>';
    else if (opt.format.audio_only) badge = '<span class="format-badge badge-audio">AUDIO</span>';
    const size = opt.format.filesize ? `${(opt.format.filesize / 1048576).toFixed(0)} MB` : '';
    item.innerHTML = `
      <div class="format-info">
        <div class="format-quality">${opt.label}</div>
        <div class="format-details">${opt.format.ext || 'mp4'} ${size ? '— ' + size : ''}</div>
      </div>
      ${badge}
    `;
    item.onclick = () => {
      list.querySelectorAll('.format-item').forEach(el => el.classList.remove('selected'));
      item.classList.add('selected');
      selectedFormat = opt.format;
    };
    list.appendChild(item);
    if (i === 0) selectedFormat = opt.format;
  });
  section.classList.remove('hidden');
}

function hideFormats() { document.getElementById('formats-section').classList.add('hidden'); }

function showProgress(title, status, pct) {
  document.getElementById('progress-title').textContent = title;
  document.getElementById('progress-status').textContent = status;
  if (pct !== undefined) document.getElementById('progress-bar').style.width = pct + '%';
  document.getElementById('progress-section').classList.remove('hidden');
}

function hideProgress() { document.getElementById('progress-section').classList.add('hidden'); }

async function downloadSelected() {
  if (!selectedFormat || !currentFormats) return;
  hideFormats();
  showProgress(currentFormats.title || 'Downloading...', 'Starting download...', 10);
  try {
    const resp = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: currentTaskId, format_id: selectedFormat.format_id, user_id: userData?.id || 0 })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Download failed');
    pollDownloadStatus(data.download_id);
  } catch (e) {
    hideProgress();
    showToast('Error: ' + e.message);
    addToHistory(currentFormats.url || '', 'error', 'Failed');
  }
}

function pollDownloadStatus(downloadId) {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const resp = await fetch(`/api/download/${downloadId}`);
      const data = await resp.json();
      if (data.status === 'downloading') {
        showProgress(data.title || 'Downloading...', data.detail || 'Downloading...', data.progress || 50);
      } else if (data.status === 'uploading') {
        showProgress(data.title || 'Uploading...', 'Uploading to Telegram...', 90);
      } else if (data.status === 'done') {
        clearInterval(pollTimer); hideProgress();
        addToHistory(data.url || '', 'done', data.title || 'Downloaded');
        showToast('Download complete!');
        if (tg?.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
      } else if (data.status === 'error') {
        clearInterval(pollTimer); hideProgress();
        showToast('Error: ' + (data.error || 'Download failed'));
        addToHistory(data.url || '', 'error', 'Failed');
      } else if (data.status === 'too_large') {
        clearInterval(pollTimer); hideProgress();
        if (data.direct_link) { showToast('File too large. Opening direct link...'); tg?.openLink(data.direct_link); }
        else showToast('File too large for Telegram upload');
      }
    } catch (e) { console.log('Poll error:', e); }
  }, 2000);
}

function addToHistory(url, status, title) {
  downloadHistory.unshift({ url, status, title: title || url, time: new Date().toISOString() });
  if (downloadHistory.length > 20) downloadHistory.pop();
  localStorage.setItem('ud_history', JSON.stringify(downloadHistory));
  renderHistory();
}

function loadHistory() {
  try { downloadHistory = JSON.parse(localStorage.getItem('ud_history') || '[]'); } catch { downloadHistory = []; }
}

function renderHistory() {
  const list = document.getElementById('history-list');
  if (downloadHistory.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="empty-icon">&#128229;</div><p>Paste a URL above to start downloading</p></div>';
    return;
  }
  list.innerHTML = downloadHistory.map(item => {
    const cls = item.status === 'done' ? 'status-done' : 'status-error';
    const time = new Date(item.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `<div class="history-item" onclick="window.open('${escapeHtml(item.url)}', '_blank')">
      <div class="history-info"><div class="history-title">${escapeHtml(item.title)}</div><div class="history-meta">${time}</div></div>
      <div class="history-status ${cls}">${item.status === 'done' ? 'Done' : 'Error'}</div>
    </div>`;
  }).join('');
}

function clearHistory() { downloadHistory = []; localStorage.removeItem('ud_history'); renderHistory(); }

function showPremiumModal() {
  document.getElementById('premium-modal').classList.remove('hidden');
  if (tg?.HapticFeedback) tg.HapticFeedback.impactOccurred('medium');
}
function closePremiumModal() { document.getElementById('premium-modal').classList.add('hidden'); }

function purchasePlan(plan) {
  if (!tg) { showToast('Open in Telegram to purchase'); return; }
  const prices = { monthly: 49, yearly: 399, lifetime: 999 };
  tg.openTelegramLink(`https://t.me/Eulerdownloadmanagerbot?start=premium_${plan}`);
  fetch('/api/premium/purchase', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userData?.id || 0, plan, stars: prices[plan] })
  }).catch(() => {});
  closePremiumModal();
  showToast('Redirecting to payment...');
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 3000);
}

function escapeHtml(str) { const d = document.createElement('div'); d.textContent = str || ''; return d.innerHTML; }

async function checkPremium() {
  try {
    const resp = await fetch('/api/user', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: userData?.id || 0 }) });
    const data = await resp.json();
    isPremium = data.premium || false;
    if (isPremium) {
      document.getElementById('btn-premium').innerHTML = '<span class="premium-icon">&#9733;</span> PRO';
      document.getElementById('btn-premium').style.background = 'linear-gradient(135deg, #00b894, #00cec9)';
    }
  } catch (e) {}
}

document.addEventListener('DOMContentLoaded', init);
