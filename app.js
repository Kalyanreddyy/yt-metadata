/* YT Translate — static GitHub Pages app. Everything runs in the browser:
   YouTube Data API (metadata) -> thumbnail download -> Tesseract.js OCR ->
   Gemini translation -> preservation checks. Keys live in localStorage. */
'use strict';

const $ = id => document.getElementById(id);
const LS_PREFIX = 'ytt_';

/* ---------- tiny storage helper ---------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem(LS_PREFIX + k); return v === null ? d : v; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(LS_PREFIX + k, v); } catch (e) {} },
  del(k) { try { localStorage.removeItem(LS_PREFIX + k); } catch (e) {} }
};

/* session (non-persisted) keys live here when "remember" is off */
const sessionKeys = { ytKey: '', gemKey: '' };

function getKeys() {
  return {
    ytKey: $('ytKey').value.trim() || sessionKeys.ytKey,
    gemKey: $('gemKey').value.trim() || sessionKeys.gemKey,
    model: $('gemModel').value.trim() || 'gemini-2.5-flash',
    ocrLang: $('ocrLang').value || 'eng'
  };
}

function loadSettings() {
  $('ytKey').value = '';
  $('gemKey').value = '';
  const r = store.get('remember', '0') === '1';
  $('remember').checked = r;
  if (r) {
    $('ytKey').value = store.get('ytKey', '');
    $('gemKey').value = store.get('gemKey', '');
  }
  $('gemModel').value = store.get('model', 'gemini-2.5-flash');
  $('ocrLang').value = store.get('ocrLang', 'eng');
  sessionKeys.ytKey = r ? '' : store.get('sessionYt', '');
  sessionKeys.gemKey = r ? '' : store.get('sessionGem', '');
}

function saveSettings() {
  const remember = $('remember').checked;
  const yt = $('ytKey').value.trim(), gem = $('gemKey').value.trim();
  store.set('remember', remember ? '1' : '0');
  store.set('model', $('gemModel').value.trim() || 'gemini-2.5-flash');
  store.set('ocrLang', $('ocrLang').value || 'eng');
  if (remember) {
    store.set('ytKey', yt); store.set('gemKey', gem);
    store.del('sessionYt'); store.del('sessionGem');
    sessionKeys.ytKey = ''; sessionKeys.gemKey = '';
  } else {
    store.del('ytKey'); store.del('gemKey');
    sessionKeys.ytKey = yt; sessionKeys.gemKey = gem;
  }
  flashStatus('Settings saved.');
}

function clearKeys() {
  ['ytKey', 'gemKey', 'remember', 'model', 'ocrLang'].forEach(k => store.del(k));
  $('ytKey').value = ''; $('gemKey').value = ''; $('remember').checked = false;
  sessionKeys.ytKey = ''; sessionKeys.gemKey = '';
  flashStatus('Saved keys removed from this device.');
}

/* ---------- video id ---------- */
function extractVideoId(url) {
  url = (url || '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(url)) return url;
  const m = url.match(/(?:youtube\.com\/watch\?.*v=|youtu\.be\/|youtube\.com\/(?:shorts|embed|live|v)\/)([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  try {
    const v = new URL(url).searchParams.get('v');
    if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
  } catch (e) {}
  return null;
}

/* ---------- ui helpers ---------- */
function setStatus(t) { $('status').textContent = t || ''; }
function flashStatus(t) { setStatus(t); setTimeout(() => { if ($('status').textContent === t) setStatus(''); }, 2500); }
function showError(t) { const e = $('error'); e.textContent = t; e.classList.remove('hidden'); }
function hideError() { $('error').classList.add('hidden'); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/* ---------- checks (port of pipeline.run_checks) ---------- */
function runChecks(original, translated, kind) {
  const out = [];
  const orig = original || '', trans = translated || '';
  if (!orig.trim()) return [{ status: 'info', message: 'No ' + kind + ' text to check.' }];
  if (!trans.trim()) return [{ status: 'warn', message: kind.charAt(0).toUpperCase() + kind.slice(1) + ' translation came back empty.' }];
  const ol = orig.split('\n'), tl = trans.split('\n');
  out.push(ol.length === tl.length
    ? { status: 'pass', message: cap(kind) + ': line count preserved (' + ol.length + ' lines).' }
    : { status: 'warn', message: cap(kind) + ': line count changed (' + ol.length + ' -> ' + tl.length + '); review line breaks.' });
  const urls = Array.from(new Set((orig.match(/https?:\/\/[^\s)>\]]+/g) || [])));
  if (urls.length) {
    const missing = urls.filter(u => trans.indexOf(u) === -1);
    out.push(missing.length
      ? { status: 'warn', message: cap(kind) + ': ' + missing.length + ' URL(s) missing from translation.' }
      : { status: 'pass', message: cap(kind) + ': all ' + urls.length + ' URL(s) preserved.' });
  }
  const onum = orig.match(/\d[\d:.,]*/g) || [], tnum = trans.match(/\d[\d:.,]*/g) || [];
  if (onum.length) {
    const missing = onum.filter(n => tnum.indexOf(n) === -1);
    out.push(missing.length
      ? { status: 'warn', message: cap(kind) + ': ' + missing.length + ' number/timestamp(s) not found in translation (' + missing.slice(0, 5).join(', ') + ').' }
      : { status: 'pass', message: cap(kind) + ': all numbers/timestamps preserved.' });
  }
  if (trans.length) {
    const ratio = trans.length / Math.max(orig.length, 1);
    if (ratio < 0.2 || ratio > 5) out.push({ status: 'warn', message: cap(kind) + ': translation length looks off (' + ratio.toFixed(1) + 'x original) — check for truncation.' });
  }
  if (!out.length) out.push({ status: 'pass', message: cap(kind) + ': basic checks passed.' });
  return out;
}
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

/* ---------- translation via Gemini ---------- */
const PROMPTS = {
  title: 'Translate the following YouTube video title into natural, fluent English. If it is already in English, return it unchanged. Return ONLY the translation — no quotes, no commentary.',
  description: 'Translate the following YouTube video description into natural, fluent English. Preserve line breaks, URLs, timestamps, numbers, hashtags and formatting exactly. If it is already in English, return it unchanged. Return ONLY the translation — no commentary.',
  thumbnail: 'Translate the following text extracted from a video thumbnail into English. Preserve the exact line structure and order: translate line by line and keep the same number of lines. If it is already in English, return it unchanged. Return ONLY the translation — no commentary.'
};

async function geminiTranslate(text, kind, gemKey, model) {
  if (!text.trim()) return '';
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(gemKey), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: PROMPTS[kind] + '\n\n' + text }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 8192 }
    })
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d.error && d.error.message) || ('HTTP ' + r.status));
  let out = ((d.candidates || [])[0] || {}).content || {};
  out = (out.parts || []).map(p => p.text || '').join('').trim();
  if (out.startsWith('```')) out = out.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim();
  return out;
}

/* ---------- main flow ---------- */
async function run() {
  hideError();
  $('results').classList.add('hidden');
  const keys = getKeys();
  const url = $('url').value.trim();
  const id = extractVideoId(url);
  if (!id) { showError('That doesn\u2019t look like a YouTube link. Try a watch?v=, youtu.be, shorts, embed or live URL.'); return; }
  if (!keys.ytKey) { showError('Add your YouTube Data API key in Key settings first.'); $('settingsCard').classList.remove('hidden'); return; }
  const watchUrl = 'https://www.youtube.com/watch?v=' + id;
  const openYt = $('openYt');
  openYt.href = watchUrl; openYt.classList.remove('hidden');
  $('go').disabled = true;

  try {
    setStatus('Fetching video info…');
    const mr = await fetch('https://www.googleapis.com/youtube/v3/videos?part=snippet&id=' + id + '&key=' + encodeURIComponent(keys.ytKey));
    const md = await mr.json().catch(() => ({}));
    if (!mr.ok) throw new Error('YouTube API: ' + ((md.error && md.error.message) || ('HTTP ' + mr.status)));
    if (!md.items || !md.items.length) throw new Error('Video not found — it may be private or deleted.');
    const s = md.items[0].snippet;
    const th = s.thumbnails || {};
    const thumbUrl = (th.maxres || th.standard || th.high || th.medium || th.default || {}).url;
    if (!thumbUrl) throw new Error('No thumbnail available for this video.');

    setStatus('Downloading thumbnail…');
    const ir = await fetch(thumbUrl);
    if (!ir.ok) throw new Error('Could not download the thumbnail (HTTP ' + ir.status + ').');
    const blob = await ir.blob();

    setStatus('Reading thumbnail text (first run downloads the OCR engine, ~15 MB)…');
    let thumbText = '';
    try {
      const worker = await Tesseract.createWorker(keys.ocrLang);
      const res = await worker.recognize(blob);
      await worker.terminate();
      thumbText = (res.data.text || '').replace(/\r\n/g, '\n').split('\n').map(l => l.replace(/\s+$/g, '')).join('\n').replace(/^\n+|\n+$/g, '');
    } catch (e) {
      console.warn('OCR failed:', e);
    }

    let enTitle = '', enDesc = '', enThumb = '';
    const checks = [];
    if (keys.gemKey) {
      setStatus('Translating…');
      try {
        [enTitle, enDesc, enThumb] = await Promise.all([
          geminiTranslate(s.title || '', 'title', keys.gemKey, keys.model),
          geminiTranslate(s.description || '', 'description', keys.gemKey, keys.model),
          geminiTranslate(thumbText, 'thumbnail', keys.gemKey, keys.model)
        ]);
      } catch (e) {
        throw new Error('Translation failed: ' + e.message);
      }
    }
    checks.push(...runChecks(s.title || '', enTitle, 'title'));
    checks.push(...runChecks(s.description || '', enDesc, 'description'));
    checks.push(...runChecks(thumbText, enThumb, 'thumbnail text'));
    if (!thumbText) checks.push({ status: 'info', message: 'No text detected on the thumbnail.' });
    if (!keys.gemKey) checks.push({ status: 'info', message: 'No Gemini key — translations skipped. Add one in Key settings.' });

    render({
      watchUrl, thumbUrl,
      channel: s.channelTitle || '', published: (s.publishedAt || '').slice(0, 10),
      lang: s.defaultLanguage || s.defaultAudioLanguage || 'unknown',
      oTitle: s.title || '', eTitle: enTitle,
      oDesc: s.description || '', eDesc: enDesc,
      oThumb: thumbText, eThumb: enThumb,
      checks, translated: !!keys.gemKey
    });
    setStatus('');
    $('newLink').classList.remove('hidden');
  } catch (e) {
    showError(e.message || String(e));
    setStatus('');
  } finally {
    $('go').disabled = false;
  }
}

/* ---------- render ---------- */
function section(id, title, body) {
  return '<section class="blk"><h2>' + esc(title) + ' <button class="copy" data-t="' + id + '">COPY</button></h2><pre id="' + id + '">' + esc(body && body.trim() ? body : '(empty)') + '</pre></section>';
}
function detail(title, body) {
  return '<details class="blk"><summary>' + esc(title) + '</summary><pre>' + esc(body && body.trim() ? body : '(empty)') + '</pre></details>';
}

function render(r) {
  const box = $('results');
  const cls = c => c.status === 'pass' ? 'ok' : c.status === 'warn' ? 'warn' : 'info';
  const icon = c => c.status === 'pass' ? '\u2713 ' : c.status === 'warn' ? '\u26a0 ' : '\u2139 ';
  let h = '';
  h += '<div class="meta">Channel: <b>' + esc(r.channel) + '</b> &middot; Published: <b>' + esc(r.published || '—') + '</b> &middot; Source language: <b>' + esc(r.lang) + '</b> &middot; <a href="' + esc(r.watchUrl) + '" target="_blank" rel="noopener" style="color:var(--acc)">Open on YouTube</a></div>';
  h += '<div class="row" style="margin-bottom:12px"><button class="go" id="copyAllEn">Copy all English</button></div>';
  h += section('eTitle', 'English Title', r.eTitle);
  h += section('eDesc', 'English Description', r.eDesc);
  h += '<section class="blk"><h2>Thumbnail</h2><img class="thumb" src="' + esc(r.thumbUrl) + '" alt="Video thumbnail"></section>';
  h += section('eThumb', 'English Thumbnail Text', r.eThumb);
  h += detail('Original Title', r.oTitle);
  h += detail('Original Description', r.oDesc);
  h += detail('Original Thumbnail Text', r.oThumb);
  h += '<div class="card"><b style="font-size:13px">Checks</b><div class="checks">' +
    r.checks.map(c => '<div class="' + cls(c) + '">' + icon(c) + esc(c.message) + '</div>').join('') + '</div></div>';
  box.innerHTML = h;
  box.classList.remove('hidden');
  box.dataset.enTitle = r.eTitle || ''; box.dataset.enDesc = r.eDesc || ''; box.dataset.enThumb = r.eThumb || '';

  box.querySelectorAll('.copy').forEach(btn => {
    btn.addEventListener('click', async () => {
      const t = document.getElementById(btn.getAttribute('data-t'));
      await copyText(t ? t.textContent : '', btn);
    });
  });
  $('copyAllEn').addEventListener('click', async (e) => {
    const all = 'ENGLISH TITLE\n' + box.dataset.enTitle + '\n\nENGLISH DESCRIPTION\n' + box.dataset.enDesc + '\n\nENGLISH THUMBNAIL TEXT\n' + box.dataset.enThumb;
    await copyText(all, e.target);
  });
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function copyText(text, btn) {
  const done = ok => {
    const old = btn.textContent;
    btn.textContent = ok ? 'COPIED \u2713' : 'COPY FAILED';
    setTimeout(() => { btn.textContent = old; }, 1400);
  };
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); done(true); return; }
    throw new Error('no clipboard api');
  } catch (e) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy');
      ta.remove(); done(!!ok);
    } catch (e2) { done(false); }
  }
}

function resetAll() {
  $('url').value = '';
  $('results').classList.add('hidden'); $('results').innerHTML = '';
  $('openYt').classList.add('hidden'); $('newLink').classList.add('hidden');
  hideError(); setStatus('');
  $('url').focus();
}

/* ---------- wire up ---------- */
$('go').addEventListener('click', () => { saveSettingsSoft(); run(); });
$('url').addEventListener('keydown', e => { if (e.key === 'Enter') { saveSettingsSoft(); run(); } });
$('newLink').addEventListener('click', resetAll);
$('settingsToggle').addEventListener('click', () => $('settingsCard').classList.toggle('hidden'));
$('saveKeys').addEventListener('click', saveSettings);
$('clearKeys').addEventListener('click', clearKeys);

/* persist typed keys to session when remember is off, so a run keeps them */
function saveSettingsSoft() {
  if ($('remember').checked) return;
  sessionKeys.ytKey = $('ytKey').value.trim() || sessionKeys.ytKey;
  sessionKeys.gemKey = $('gemKey').value.trim() || sessionKeys.gemKey;
}

loadSettings();
