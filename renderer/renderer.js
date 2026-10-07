'use strict';

// Novela renderer — behavior, i18n (12 languages), Monaco editors with Luau
// completion, Prof options, HTTP API mode and local-server controls.

const $ = (id) => document.getElementById(id);

const SETTINGS_KEY = 'novela.settings.v3';

const PROF_DEFAULTS = {
  flow: true, vm: true, strings: true, garbage: true, anti: true, env: true,
  crypto: 0, encoding: 0, comp: true,
  integrity: true, chartable: true, gsub: true, lazy: true,
  opaque: true, junkstyle: 0, identstyle: 0,
  dispatcher: 0, split: true, splitThr: 24, decoys: 3, shuffle: true,
  arrsize: 100, digits: 6, tshuffle: true, nummask: 2,
};

const DEFAULTS = {
  lang: 'en', theme: 'turtle',
  junk: 100, layers: 3, watermark: '', execlogs: false, seedAuto: true,
  strip: true, rename: true, seed: 42,
  prof: { ...PROF_DEFAULTS },
  apiUrl: 'http://127.0.0.1:4477', apiToken: '', useApi: false,
  srvPort: 4477, srvToken: '',
  pasteProvider: 'pastebin', pastebinKey: '', pastefyKey: '',
};

let settings = JSON.parse(JSON.stringify(DEFAULTS));

const SAMPLE = [
  '-- Sample Luau script',
  'local greeting = "hello world"',
  '',
  'local function add(a, b)',
  '  return a + b',
  'end',
  '',
  'local total = 0',
  'for i = 1, 10 do',
  '  if i % 2 == 0 then',
  '    total = total + add(i, i * 2)',
  '  end',
  'end',
  '',
  'print(greeting, total)',
  'return total',
].join('\n');

let serverCfg = { serverPort: 4477, serverToken: '', serverAutostart: false, appAutostart: false, minimizeToTray: true };
let serverState = { running: false };
let backendAvailable = false;
let unreadLogs = 0;
let inputEditor = null;
let outputEditor = null;
let editorsReady = false;

try {
  const raw = localStorage.getItem(SETTINGS_KEY);
  if (raw) {
    const parsed = JSON.parse(raw);
    settings = { ...JSON.parse(JSON.stringify(DEFAULTS)), ...parsed };
    settings.prof = { ...PROF_DEFAULTS, ...(parsed.prof || {}) };
  }
} catch { /* corrupted storage: fall back to defaults */ }

function persist() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
}

// ---------- i18n ----------

function t(key) {
  const lang = window.NOVELA_LOCALES[settings.lang] ? settings.lang : 'en';
  const dict = window.NOVELA_LOCALES[lang] || {};
  if (key in dict) return dict[key];
  if (key in window.NOVELA_LOCALES.en) return window.NOVELA_LOCALES.en[key];
  return key;
}

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  document.querySelectorAll('[data-i18n-ph]').forEach((el) => {
    el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph')));
  });
  document.documentElement.lang = settings.lang;
  document.documentElement.dir = settings.lang === 'ar' ? 'rtl' : 'ltr';
  const sel = $('langSelect');
  sel.innerHTML = '';
  window.NOVELA_LANGS.forEach((l) => {
    const opt = document.createElement('option');
    opt.value = l.code;
    opt.textContent = l.label;
    if (l.code === settings.lang) opt.selected = true;
    sel.appendChild(opt);
  });
  renderLogCount();
  updateMeta();
  renderServerStatus();
}

// ---------- Logs ----------

function fmtTime(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function renderLogCount() {
  const empty = $('logList').querySelector('.log-empty');
  if (empty) { $('logCount').textContent = '0'; return; }
  $('logCount').textContent = t('log.count').replace('{n}', String($('logList').children.length));
}

function addLog(level, msg) {
  const list = $('logList');
  const empty = list.querySelector('.log-empty');
  if (empty) empty.remove();
  const entry = document.createElement('div');
  entry.className = `log-entry ${level}`;
  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = fmtTime(new Date());
  const body = document.createElement('span');
  body.className = 'log-msg';
  body.textContent = msg;
  entry.appendChild(time);
  entry.appendChild(body);
  list.appendChild(entry);
  while (list.children.length > 500) list.removeChild(list.firstChild);
  list.scrollTop = list.scrollHeight;
  renderLogCount();
  if (!$('view-logs').classList.contains('active')) {
    unreadLogs += 1;
    const badge = $('logBadge');
    badge.textContent = String(Math.min(unreadLogs, 99));
    badge.classList.remove('hidden');
  }
}

// ---------- Switches / sliders / selects ----------

function bindSwitch(id, get, set) {
  const el = $(id);
  const paint = () => el.setAttribute('aria-checked', get() ? 'true' : 'false');
  paint();
  el.addEventListener('click', () => { set(!get()); paint(); persist(); });
  return paint;
}

function paintSlider(el, valEl) {
  const min = Number(el.min), max = Number(el.max), v = Number(el.value);
  const pct = max === min ? 0 : ((v - min) / (max - min)) * 100;
  el.style.setProperty('--fill', pct + '%');
  valEl.textContent = String(v);
}

// ---------- Themes ----------

const MONACO_BG = { turtle: '#08130d', novela: '#141414', midnight: '#080d16', forest: '#090f0c', ember: '#120d09' };

function applyTheme() {
  const valid = ['turtle', 'novela', 'midnight', 'forest', 'ember'];
  const theme = valid.includes(settings.theme) ? settings.theme : 'turtle';
  settings.theme = theme;
  document.documentElement.setAttribute('data-theme', theme === 'novela' ? '' : theme);
  if (theme === 'novela') document.documentElement.removeAttribute('data-theme');
  document.querySelectorAll('.theme-opt').forEach((b) => {
    b.classList.toggle('active', b.dataset.theme === theme);
  });
  try {
    if (editorsReady && window.monaco) {
      window.monaco.editor.setTheme('novela-' + theme);
    }
  } catch { /* monaco not ready yet */ }
  persist();
}

// ---------- Monaco ----------

const LUA_KEYWORDS = ['and', 'break', 'continue', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while', 'type', 'export', 'self'];
const LUA_GLOBALS = [
  ['print', 'print(...)', 'Output values to the console'],
  ['require', 'require(name)', 'Load a module'],
  ['pairs', 'pairs(t)', 'Iterate key-value pairs'],
  ['ipairs', 'ipairs(t)', 'Iterate array part'],
  ['tostring', 'tostring(v)', 'Convert to string'],
  ['tonumber', 'tonumber(s)', 'Convert to number'],
  ['assert', 'assert(v, msg)', 'Assert a condition'],
  ['error', 'error(msg)', 'Raise an error'],
  ['pcall', 'pcall(f, ...)', 'Protected call'],
  ['xpcall', 'xpcall(f, err)', 'Protected call with handler'],
  ['select', 'select(i, ...)', 'Vararg selection'],
  ['unpack', 'unpack(t)', 'Unpack a table (5.1)'],
  ['loadstring', 'loadstring(chunk)', 'Compile a chunk'],
  ['setmetatable', 'setmetatable(t, mt)', 'Set a metatable'],
  ['getmetatable', 'getmetatable(t)', 'Get a metatable'],
  ['rawget', 'rawget(t, k)', 'Raw table access'],
  ['rawset', 'rawset(t, k, v)', 'Raw table write'],
  ['rawequal', 'rawequal(a, b)', 'Identity comparison'],
  ['next', 'next(t, k)', 'Next key in table'],
  ['typeof', 'typeof(v)', 'Luau type name'],
];
const LUA_LIBS = [
  ['string.byte', 'string.byte(s [, i [, j]])', 'Character codes'],
  ['string.char', 'string.char(...)', 'Codes to string'],
  ['string.find', 'string.find(s, pattern)', 'Pattern search'],
  ['string.format', 'string.format(fmt, ...)', 'Format a string'],
  ['string.gmatch', 'string.gmatch(s, pattern)', 'Pattern iterator'],
  ['string.gsub', 'string.gsub(s, pattern, repl)', 'Replace pattern'],
  ['string.len', 'string.len(s)', 'String length'],
  ['string.lower', 'string.lower(s)', 'Lowercase'],
  ['string.upper', 'string.upper(s)', 'Uppercase'],
  ['string.rep', 'string.rep(s, n)', 'Repeat string'],
  ['string.reverse', 'string.reverse(s)', 'Reverse string'],
  ['string.sub', 'string.sub(s, i [, j])', 'Substring'],
  ['string.split', 'string.split(s, sep)', 'Split string (Luau)'],
  ['table.concat', 'table.concat(t [, sep])', 'Join array'],
  ['table.insert', 'table.insert(t [, pos,] v)', 'Insert value'],
  ['table.remove', 'table.remove(t [, pos])', 'Remove value'],
  ['table.sort', 'table.sort(t [, comp])', 'Sort array'],
  ['table.pack', 'table.pack(...)', 'Pack varargs'],
  ['table.unpack', 'table.unpack(t)', 'Unpack array'],
  ['table.create', 'table.create(n [, v])', 'Sized table (Luau)'],
  ['table.find', 'table.find(t, v)', 'Find value (Luau)'],
  ['table.clear', 'table.clear(t)', 'Clear table (Luau)'],
  ['table.clone', 'table.clone(t)', 'Shallow copy (Luau)'],
  ['math.abs', 'math.abs(x)', 'Absolute value'],
  ['math.floor', 'math.floor(x)', 'Round down'],
  ['math.ceil', 'math.ceil(x)', 'Round up'],
  ['math.max', 'math.max(...)', 'Maximum'],
  ['math.min', 'math.min(...)', 'Minimum'],
  ['math.random', 'math.random([m [, n]])', 'Random number'],
  ['math.sqrt', 'math.sqrt(x)', 'Square root'],
  ['math.sin', 'math.sin(x)', 'Sine'],
  ['math.cos', 'math.cos(x)', 'Cosine'],
  ['math.pi', 'math.pi', 'Pi constant'],
  ['math.huge', 'math.huge', 'Infinity'],
  ['math.clamp', 'math.clamp(x, a, b)', 'Clamp (Luau)'],
  ['math.sign', 'math.sign(x)', 'Sign (Luau)'],
  ['math.round', 'math.round(x)', 'Round (Luau)'],
  ['coroutine.create', 'coroutine.create(f)', 'New coroutine'],
  ['coroutine.resume', 'coroutine.resume(co)', 'Resume coroutine'],
  ['coroutine.wrap', 'coroutine.wrap(f)', 'Wrap coroutine'],
  ['coroutine.yield', 'coroutine.yield(...)', 'Yield values'],
  ['os.clock', 'os.clock()', 'CPU time'],
  ['os.time', 'os.time()', 'Epoch time'],
  ['os.date', 'os.date(fmt)', 'Format date'],
  ['bit32.band', 'bit32.band(...)', 'Bitwise AND'],
  ['bit32.bor', 'bit32.bor(...)', 'Bitwise OR'],
  ['bit32.bxor', 'bit32.bxor(...)', 'Bitwise XOR'],
  ['bit32.lshift', 'bit32.lshift(x, n)', 'Shift left'],
  ['bit32.rshift', 'bit32.rshift(x, n)', 'Shift right'],
  ['utf8.char', 'utf8.char(...)', 'Codepoints to string'],
  ['utf8.len', 'utf8.len(s)', 'UTF-8 length'],
];

function registerLuauCompletion() {
  const monaco = window.monaco;
  monaco.languages.registerCompletionItemProvider('lua', {
    triggerCharacters: ['.', ':'],
    provideCompletionItems: (model, position) => {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const suggestions = [];
      LUA_KEYWORDS.forEach((k) => {
        suggestions.push({ label: k, kind: monaco.languages.CompletionItemKind.Keyword, insertText: k, range });
      });
      const fn = (label, insert, detail) => {
        suggestions.push({ label, kind: monaco.languages.CompletionItemKind.Function, insertText: insert, detail, range });
      };
      LUA_GLOBALS.forEach(([label, insert, detail]) => fn(label, insert, detail));
      LUA_LIBS.forEach(([label, insert, detail]) => fn(label, insert, detail));
      return { suggestions };
    },
  });
}

function initMonaco() {
  try {
    // eslint-disable-next-line no-undef
    require.config({ paths: { vs: '../vendor/monaco/vs' } });
  } catch (err) {
    addLog('error', 'Monaco loader missing: vendor/monaco/vs/loader.js. Run scripts/sync-monaco.ps1.');
    return;
  }
  self.MonacoEnvironment = {
    getWorkerUrl: () => '../vendor/monaco/vs/base/worker/workerMain.js',
  };
  // eslint-disable-next-line no-undef
  require(['vs/editor/editor.main'], () => {
    const monaco = window.monaco;
    Object.entries(MONACO_BG).forEach(([name, bg]) => {
      monaco.editor.defineTheme('novela-' + name, {
        base: 'vs-dark', inherit: true, rules: [],
        colors: { 'editor.background': bg },
      });
    });
    registerLuauCompletion();
    const opts = {
      language: 'lua',
      fontFamily: "'Cascadia Code','JetBrains Mono',Consolas,monospace",
      fontSize: 12.5,
      lineHeight: 1.55,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      automaticLayout: true,
      padding: { top: 10 },
      renderLineHighlight: 'all',
      quickSuggestions: true,
      suggestOnTriggerCharacters: true,
      tabCompletion: 'on',
      parameterHints: { enabled: true },
    };
    inputEditor = monaco.editor.create($('inputEditor'), { ...opts, readOnly: false });
    outputEditor = monaco.editor.create($('outputEditor'), { ...opts, readOnly: true });
    inputEditor.onDidChangeModelContent(updateMeta);
    outputEditor.onDidChangeModelContent(updateMeta);
    editorsReady = true;
    monaco.editor.setTheme('novela-' + (settings.theme || 'novela'));
    updateMeta();
  });
}

function getInput() { return editorsReady && inputEditor ? inputEditor.getValue() : ''; }
function setInput(v) { if (editorsReady && inputEditor) { inputEditor.setValue(v); updateMeta(); } }
function setOutput(v) { if (editorsReady && outputEditor) { outputEditor.setValue(v); updateMeta(); } }

// ---------- Backend status ----------

function renderBackendStatus(info) {
  $('backendPath').textContent = info.path || '–';
  $('backendVersion').textContent = info.version ? 'v' + info.version : '–';
  $('backendState').textContent = info.available ? t('set.connected') : t('set.unavailable');
  $('backendError').textContent = info.available ? '' : (info.lastError || '');
  backendAvailable = !!info.available;
}

async function refreshBackend() {
  if (!window.novela) return;
  try {
    const info = await window.novela.backendStatus();
    renderBackendStatus(info);
    addLog(info.available ? 'ok' : 'error',
      info.available ? `${t('m.backendOk')} (${info.path})` : `${t('m.backendBad')}${info.lastError || ''}`);
  } catch (err) {
    renderBackendStatus({ available: false, path: null, lastError: String(err && err.message || err) });
  }
}

// ---------- Local server ----------

function renderServerStatus() {
  const el = $('srvStatus');
  if (!el) return;
  if (serverState.running) {
    el.textContent = `${t('api.running')}: ${serverState.port}`;
  } else if (serverState.error) {
    el.textContent = serverState.error;
  } else {
    el.textContent = t('api.stopped');
  }
  const btn = $('srvToggleLabel');
  if (btn) btn.textContent = t(serverState.running ? 'api.stop' : 'api.start');
}

async function loadServerCfg() {
  try {
    serverCfg = { ...serverCfg, ...(await window.novela.serverSettings()) };
  } catch { /* keep defaults */ }
  $('srvPort').value = serverCfg.serverPort;
  $('srvToken').value = serverCfg.serverToken || '';
  paintSwitches();
  try {
    serverState = await window.novela.serverStatus();
  } catch { /* ignore */ }
  renderServerStatus();
}

async function saveServerCfg() {
  serverCfg.serverPort = Math.max(1, Math.min(65535, Number($('srvPort').value) || 4477));
  serverCfg.serverToken = $('srvToken').value || '';
  try {
    serverCfg = { ...serverCfg, ...(await window.novela.serverSave(serverCfg)) };
  } catch { /* ignore */ }
}

// ---------- Navigation ----------

function switchView(name) {
  document.querySelectorAll('.rail-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === name);
  });
  document.querySelectorAll('.view').forEach((v) => {
    v.classList.toggle('active', v.id === `view-${name}`);
  });
  if (name === 'logs') {
    unreadLogs = 0;
    $('logBadge').classList.add('hidden');
  }
}

// ---------- Editor meta ----------

function updateMeta() {
  const src = getInput();
  $('inputMeta').textContent = src.length === 0 ? `0 ${t('in.chars')} · 0 ${t('in.lines')}`
    : `${src.length.toLocaleString('en-US')} ${t('in.chars')} · ${src.split('\n').length.toLocaleString('en-US')} ${t('in.lines')}`;
  const out = editorsReady && outputEditor ? outputEditor.getValue() : '';
  $('outputMeta').textContent = out.length === 0 ? t('out.empty')
    : `${out.length.toLocaleString('en-US')} ${t('in.chars')} · ${out.split('\n').length.toLocaleString('en-US')} ${t('in.lines')}`;
}

// ---------- Obfuscation ----------

function collectOptions() {
  const p = settings.prof;
  return {
    controlFlowFlattening: !!p.flow,
    customVm: !!p.vm,
    garbageInjection: !!p.garbage,
    stringEncryption: !!p.strings,
    antiTamper: !!p.anti,
    environmentChecks: !!p.env,
    junkVolume: Math.max(0, Math.min(100, Number(settings.junk) || 0)),
    vmLayers: Math.max(1, Math.min(3, Number(settings.layers) || 3)),
    watermark: String(settings.watermark || ''),
    executorLogs: !!settings.execlogs,
    renameIdentifiers: !!settings.rename,
    stripComments: !!settings.strip,
    cryptoMode: Math.max(0, Math.min(2, Number(p.crypto) || 0)),
    encodingMode: Math.max(0, Math.min(2, Number(p.encoding) || 0)),
    useCompression: !!p.comp,
    integrityCheck: !!p.integrity,
    charTable: !!p.chartable,
    gsubBatch: !!p.gsub,
    lazyStrings: !!p.lazy,
    opaquePredicates: !!p.opaque,
    junkStyle: Math.max(0, Math.min(2, Number(p.junkstyle) || 0)),
    identStyle: Math.max(0, Math.min(1, Number(p.identstyle) || 0)),
    dispatcherKind: p.dispatcher === 1 ? 1 : 0,
    stringSplit: !!p.split,
    splitThreshold: Math.max(8, Math.min(64, Number(p.splitThr) || 24)),
    decoys: Math.max(0, Math.min(6, Number.isFinite(Number(p.decoys)) ? Number(p.decoys) : 3)),
    shuffleDefs: !!p.shuffle,
    junkArraySize: Math.max(20, Math.min(200, Number(p.arrsize) || 100)),
    stateIdDigits: Math.max(3, Math.min(6, Number(p.digits) || 6)),
    tableShuffle: !!p.tshuffle,
    numberMask: Math.max(0, Math.min(2, Number(p.nummask) || 0)),
  };
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

async function obfuscateViaApi(source, options, seed) {
  const base = (settings.apiUrl || '').replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (settings.apiToken) headers['X-Novela-Token'] = settings.apiToken;
  const res = await fetch(base + '/api/obfuscate', {
    method: 'POST',
    headers,
    body: JSON.stringify({ source, options, seed }),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error || ''; } catch { /* ignore */ }
    return { ok: false, error: `API ${res.status}${detail ? ': ' + detail : ''}` };
  }
  const data = await res.json();
  if (!data.success) return { ok: false, error: data.error || 'Obfuscation failed.', logs: data.logs || [] };
  return { ok: true, output: data.output, stats: data.stats, logs: data.logs || [] };
}

async function runObfuscation() {
  if (!editorsReady) return;
  const source = getInput();
  if (!source.trim()) {
    addLog('error', t('m.emptyInput'));
    return;
  }
  let seed;
  if (settings.seedAuto) {
    seed = Math.floor(Math.random() * 2147483647);
  } else {
    seed = Number($('seedInput').value);
    if (!Number.isFinite(seed)) seed = Math.floor(Math.random() * 2147483647);
    seed = Math.floor(Math.abs(seed)) % 2147483647;
  }
  $('seedInput').value = seed;
  settings.seed = seed;
  settings.watermark = $('watermarkInput').value || '';
  persist();

  const viaApi = !!settings.useApi;
  const btn = $('btnObfuscate');
  btn.disabled = true;
  $('obfuscateProgress').classList.remove('hidden');
  $('statsRow').classList.add('hidden');
  addLog('info', `${t('m.jobStarted')} (${source.length} chars, seed ${seed}${viaApi ? ', API' : ''}).`);

  const started = performance.now();
  try {
    const res = viaApi
      ? await obfuscateViaApi(source, collectOptions(), seed)
      : await window.novela.obfuscate({ source, options: collectOptions(), seed });
    const elapsed = Math.round(performance.now() - started);
    if (!res.ok) {
      addLog('error', `${t('m.jobFailed')}${res.error || ''}`);
      (res.logs || []).forEach((l) => addLog('info', `backend: ${l}`));
      return;
    }
    setOutput(res.output || '');
    const s = res.stats || {};
    $('statIn').textContent = fmtBytes(s.inputBytes || 0);
    $('statOut').textContent = fmtBytes(s.outputBytes || 0);
    $('statRatio').textContent = (s.ratio || 0).toFixed(2) + 'x';
    $('statTime').textContent = `${s.elapsedMs || 0} ms`;
    $('statMode').textContent = s.mode || '–';
    $('statsRow').classList.remove('hidden');
    (res.logs || []).forEach((l) => addLog('info', `backend: ${l}`));
    addLog('ok', `${t('m.jobDone')} ${elapsed} ms.`);
  } catch (err) {
    addLog('error', `${t('m.jobFailed')}${String(err && err.message || err)}`);
  } finally {
    btn.disabled = false;
    $('obfuscateProgress').classList.add('hidden');
  }
}

// ---------- Wiring ----------

let switchPainters = [];
function paintSwitches() { switchPainters.forEach((p) => p()); }

function init() {
  if (!window.novela) {
    document.body.insertAdjacentHTML('beforeend',
      '<div style="position:fixed;bottom:12px;right:12px;background:#5c2b29;color:#fff;padding:10px 16px;border-radius:12px;font-size:13px">Preload bridge unavailable. Run inside Electron.</div>');
    return;
  }

  const P = () => settings.prof;
  switchPainters = [
    bindSwitch('swExecLogs', () => settings.execlogs, (v) => { settings.execlogs = v; }),
    bindSwitch('swSeedAuto', () => settings.seedAuto, (v) => { settings.seedAuto = v; }),
    bindSwitch('swStrip', () => settings.strip, (v) => { settings.strip = v; }),
    bindSwitch('swRename', () => settings.rename, (v) => { settings.rename = v; }),
    bindSwitch('swUseApi', () => settings.useApi, (v) => { settings.useApi = v; }),
    bindSwitch('pfFlow', () => P().flow, (v) => { P().flow = v; }),
    bindSwitch('pfVm', () => P().vm, (v) => { P().vm = v; }),
    bindSwitch('pfStrings', () => P().strings, (v) => { P().strings = v; }),
    bindSwitch('pfGarbage', () => P().garbage, (v) => { P().garbage = v; }),
    bindSwitch('pfAnti', () => P().anti, (v) => { P().anti = v; }),
    bindSwitch('pfEnv', () => P().env, (v) => { P().env = v; }),
    bindSwitch('pfComp', () => P().comp, (v) => { P().comp = v; }),
    bindSwitch('pfIntegrity', () => P().integrity, (v) => { P().integrity = v; }),
    bindSwitch('pfCharTable', () => P().chartable, (v) => { P().chartable = v; }),
    bindSwitch('pfGsub', () => P().gsub, (v) => { P().gsub = v; }),
    bindSwitch('pfLazy', () => P().lazy, (v) => { P().lazy = v; }),
    bindSwitch('pfOpaque', () => P().opaque, (v) => { P().opaque = v; }),
    bindSwitch('pfSplit', () => P().split, (v) => { P().split = v; }),
    bindSwitch('pfShuffle', () => P().shuffle, (v) => { P().shuffle = v; }),
    bindSwitch('pfTshuffle', () => P().tshuffle, (v) => { P().tshuffle = v; }),
    bindSwitch('swSrvAuto', () => !!serverCfg.serverAutostart, (v) => { serverCfg.serverAutostart = v; saveServerCfg(); }),
    bindSwitch('swAppAuto', () => !!serverCfg.appAutostart, (v) => { serverCfg.appAutostart = v; saveServerCfg(); }),
    bindSwitch('swTray', () => !!serverCfg.minimizeToTray, (v) => { serverCfg.minimizeToTray = v; saveServerCfg(); }),
  ];
  paintSwitches();

  $('sliderJunk').value = settings.junk;
  $('sliderLayers').value = settings.layers;
  $('watermarkInput').value = settings.watermark || '';
  $('seedInput').value = settings.seed;
  $('selCrypto').value = String(P().crypto);
  $('selEncoding').value = String(P().encoding);
  $('selJunkStyle').value = String(P().junkstyle);
  $('selIdentStyle').value = String(P().identstyle);
  $('selDispatch').value = String(P().dispatcher);
  $('selNumMask').value = String(P().nummask);
  $('selDigits').value = String(P().digits);
  $('sliderSplitThr').value = P().splitThr;
  $('sliderDecoys').value = P().decoys;
  $('sliderArrSize').value = P().arrsize;
  $('apiUrl').value = settings.apiUrl;
  $('apiToken').value = settings.apiToken || '';
  $('selPasteProvider').value = settings.pasteProvider === 'pastefy' ? 'pastefy' : 'pastebin';
  $('pastebinKey').value = settings.pastebinKey || '';
  $('pastefyKey').value = settings.pastefyKey || '';
  paintSlider($('sliderJunk'), $('junkVal'));
  paintSlider($('sliderLayers'), $('layersVal'));
  paintSlider($('sliderSplitThr'), $('splitThrVal'));
  paintSlider($('sliderDecoys'), $('decoysVal'));
  paintSlider($('sliderArrSize'), $('arrSizeVal'));

  const syncProf = () => { persist(); };
  $('sliderJunk').addEventListener('input', () => {
    settings.junk = Number($('sliderJunk').value);
    paintSlider($('sliderJunk'), $('junkVal'));
    persist();
  });
  $('sliderLayers').addEventListener('input', () => {
    settings.layers = Number($('sliderLayers').value);
    paintSlider($('sliderLayers'), $('layersVal'));
    persist();
  });
  $('watermarkInput').addEventListener('input', () => {
    settings.watermark = $('watermarkInput').value;
    persist();
  });
  $('selCrypto').addEventListener('change', () => { P().crypto = Number($('selCrypto').value); syncProf(); });
  $('selEncoding').addEventListener('change', () => { P().encoding = Number($('selEncoding').value); syncProf(); });
  $('selJunkStyle').addEventListener('change', () => { P().junkstyle = Number($('selJunkStyle').value); syncProf(); });
  $('selIdentStyle').addEventListener('change', () => { P().identstyle = Number($('selIdentStyle').value); syncProf(); });
  $('selDispatch').addEventListener('change', () => { P().dispatcher = Number($('selDispatch').value); syncProf(); });
  $('selNumMask').addEventListener('change', () => { P().nummask = Number($('selNumMask').value); syncProf(); });
  $('selDigits').addEventListener('change', () => { P().digits = Number($('selDigits').value); syncProf(); });
  const bindSlider = (id, valId, set) => {
    $(id).addEventListener('input', () => {
      set(Number($(id).value));
      paintSlider($(id), $(valId));
      persist();
    });
  };
  bindSlider('sliderSplitThr', 'splitThrVal', (v) => { P().splitThr = v; });
  bindSlider('sliderDecoys', 'decoysVal', (v) => { P().decoys = v; });
  bindSlider('sliderArrSize', 'arrSizeVal', (v) => { P().arrsize = v; });
  $('apiUrl').addEventListener('input', () => { settings.apiUrl = $('apiUrl').value; persist(); });
  $('apiToken').addEventListener('input', () => { settings.apiToken = $('apiToken').value; persist(); });
  $('selPasteProvider').addEventListener('change', () => {
    settings.pasteProvider = $('selPasteProvider').value === 'pastefy' ? 'pastefy' : 'pastebin';
    persist();
  });
  $('pastebinKey').addEventListener('input', () => { settings.pastebinKey = $('pastebinKey').value; persist(); });
  $('pastefyKey').addEventListener('input', () => { settings.pastefyKey = $('pastefyKey').value; persist(); });

  document.querySelectorAll('.rail-item').forEach((b) => {
    b.addEventListener('click', () => switchView(b.dataset.view));
  });

  document.querySelectorAll('.theme-opt').forEach((b) => {
    b.addEventListener('click', () => {
      settings.theme = b.dataset.theme;
      applyTheme();
    });
  });

  $('btnMin').addEventListener('click', () => window.novela.windowControl('minimize'));
  $('btnMax').addEventListener('click', () => window.novela.windowControl('toggle-maximize'));
  $('btnClose').addEventListener('click', () => window.novela.windowControl('close'));

  $('btnOpenFile').addEventListener('click', async () => {
    const res = await window.novela.openFile();
    if (res.canceled) return;
    if (!res.ok) { addLog('error', `${t('m.readErr')}${res.error}`); return; }
    setInput(res.content);
    addLog('info', `${t('m.opened')}${res.path} (${res.content.length} chars).`);
  });

  $('btnClearInput').addEventListener('click', () => setInput(''));

  $('btnSampleInput').addEventListener('click', () => {
    setInput(SAMPLE);
    addLog('info', t('m.sample'));
  });

  $('btnCopyOutput').addEventListener('click', async () => {
    const text = outputEditor ? outputEditor.getValue() : '';
    if (!text) { addLog('error', t('m.copyEmpty')); return; }
    try {
      await navigator.clipboard.writeText(text);
      addLog('ok', `${t('m.copied')} (${text.length} chars).`);
    } catch {
      addLog('error', t('m.copyEmpty'));
    }
  });

  $('btnSaveOutput').addEventListener('click', async () => {
    const text = outputEditor ? outputEditor.getValue() : '';
    if (!text) { addLog('error', t('m.saveEmpty')); return; }
    const res = await window.novela.saveFile({ content: text, defaultName: 'obfuscated.lua' });
    if (res.canceled) return;
    if (!res.ok) { addLog('error', `${t('m.saveErr')}${res.error}`); return; }
    addLog('ok', `${t('m.saved')}${res.path}.`);
  });

  $('btnLoadstring').addEventListener('click', async () => {
    const text = outputEditor ? outputEditor.getValue() : '';
    if (!text) { addLog('error', t('m.saveEmpty')); return; }
    const provider = settings.pasteProvider === 'pastefy' ? 'pastefy' : 'pastebin';
    const key = provider === 'pastefy' ? settings.pastefyKey : settings.pastebinKey;
    if (!key) { addLog('error', t('m.pasteNeedKey')); return; }
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const rnd = new Uint32Array(10);
    crypto.getRandomValues(rnd);
    const name = 'novela-' + [...rnd].map((n) => chars[n % chars.length]).join('');
    addLog('info', `${t('m.pasteUp')} (${provider}, ${name})…`);
    try {
      const res = await window.novela.pasteUpload({ provider, key, name, content: text });
      if (!res.ok) { addLog('error', `${t('m.pasteFail')}${res.error || ''}`); return; }
      const snippet = `loadstring(game:HttpGet("${res.raw}"))()`;
      try {
        await navigator.clipboard.writeText(snippet);
      } catch { /* clipboard unavailable: log carries the snippet */ }
      addLog('ok', `${t('m.pasteOk')} ${res.raw}`);
      addLog('ok', snippet);
    } catch (err) {
      addLog('error', `${t('m.pasteFail')}${String(err && err.message || err)}`);
    }
  });

  $('btnRandomSeed').addEventListener('click', () => {
    const seed = Math.floor(Math.random() * 2147483647);
    $('seedInput').value = seed;
    settings.seed = seed;
    persist();
  });

  $('btnObfuscate').addEventListener('click', runObfuscation);

  $('btnPing').addEventListener('click', refreshBackend);
  $('btnResetSettings').addEventListener('click', () => {
    const keep = { seed: settings.seed, lang: settings.lang, theme: settings.theme };
    const prof = settings.prof;
    settings = { ...JSON.parse(JSON.stringify(DEFAULTS)), ...keep, prof };
    $('sliderJunk').value = settings.junk;
    $('sliderLayers').value = settings.layers;
    $('watermarkInput').value = settings.watermark || '';
    $('seedInput').value = settings.seed;
    $('apiUrl').value = settings.apiUrl;
    $('apiToken').value = settings.apiToken || '';
    $('selPasteProvider').value = 'pastebin';
    $('pastebinKey').value = '';
    $('pastefyKey').value = '';
    paintSwitches();
    paintSlider($('sliderJunk'), $('junkVal'));
    paintSlider($('sliderLayers'), $('layersVal'));
    applyTheme();
    persist();
    addLog('info', t('m.reset'));
  });

  $('btnProfReset').addEventListener('click', () => {
    settings.prof = { ...PROF_DEFAULTS };
    $('selCrypto').value = '0';
    $('selEncoding').value = '0';
    $('selJunkStyle').value = '0';
    $('selIdentStyle').value = '0';
    $('selDispatch').value = '0';
    $('selNumMask').value = '2';
    $('selDigits').value = '6';
    $('sliderSplitThr').value = settings.prof.splitThr;
    $('sliderDecoys').value = settings.prof.decoys;
    $('sliderArrSize').value = settings.prof.arrsize;
    paintSwitches();
    paintSlider($('sliderSplitThr'), $('splitThrVal'));
    paintSlider($('sliderDecoys'), $('decoysVal'));
    paintSlider($('sliderArrSize'), $('arrSizeVal'));
    persist();
    addLog('info', t('prof.resetDone'));
  });

  $('btnApiTest').addEventListener('click', async () => {
    const base = ($('apiUrl').value || '').replace(/\/+$/, '');
    $('apiTestResult').textContent = '…';
    try {
      const headers = {};
      if ($('apiToken').value) headers['X-Novela-Token'] = $('apiToken').value;
      const res = await fetch(base + '/api/health', { headers });
      const data = await res.json();
      $('apiTestResult').textContent = data.status === 'ok' ? `ok · v${data.version || '?'}` : 'bad response';
      addLog(data.status === 'ok' ? 'ok' : 'error', `${t('api.tested')} ${base}: ${$('apiTestResult').textContent}`);
    } catch (err) {
      $('apiTestResult').textContent = t('api.unreachable');
      addLog('error', `${t('api.tested')} ${base}: ${String(err && err.message || err)}`);
    }
  });

  $('btnSrvToggle').addEventListener('click', async () => {
    if (serverState.running) {
      serverState = await window.novela.serverStop();
    } else {
      serverCfg.serverPort = Math.max(1, Math.min(65535, Number($('srvPort').value) || 4477));
      serverCfg.serverToken = $('srvToken').value || '';
      await saveServerCfg();
      serverState = await window.novela.serverStart({ port: serverCfg.serverPort, token: serverCfg.serverToken });
      if (serverState.error) addLog('error', serverState.error);
      else addLog('ok', `${t('api.srvStarted')} :${serverState.port}`);
    }
    renderServerStatus();
  });

  $('langSelect').addEventListener('change', () => {
    settings.lang = $('langSelect').value;
    persist();
    applyI18n();
    refreshBackend();
  });

  $('btnClearLogs').addEventListener('click', () => {
    $('logList').innerHTML = `<div class="log-empty">${t('log.cleared')}</div>`;
    renderLogCount();
  });

  // Fullscreen editors (whole-window overlay per pane).
  const relayoutEditors = () => {
    // Force a synchronous reflow first: after an overlay size jump the grid
    // may otherwise keep blown-up tracks, and Monaco would re-measure them.
    try {
      void document.getElementById('view-obfuscator').offsetWidth;
      if (inputEditor) inputEditor.layout();
      if (outputEditor) outputEditor.layout();
    } catch { /* editor not ready */ }
  };
  const exitFullscreen = () => {
    const was = document.querySelector('.pane.fullscreen');
    document.querySelectorAll('.pane.fullscreen').forEach((p) => p.classList.remove('fullscreen'));
    if (was) {
      relayoutEditors();
      setTimeout(relayoutEditors, 250);
    }
  };
  const toggleFullscreen = (btnId, paneIdx, editor) => {
    $(btnId).addEventListener('click', () => {
      const panes = document.querySelectorAll('#view-obfuscator .pane');
      const target = panes[paneIdx];
      const was = target.classList.contains('fullscreen');
      exitFullscreen();
      if (!was) {
        target.classList.add('fullscreen');
        relayoutEditors();
        setTimeout(relayoutEditors, 250);
        try { if (editor && editor()) editor().focus(); } catch { /* ignore */ }
      }
    });
  };
  toggleFullscreen('btnFullInput', 0, () => inputEditor);
  toggleFullscreen('btnFullOutput', 1, () => outputEditor);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') exitFullscreen();
  });

  window.novela.onBackendStatus((info) => renderBackendStatus(info));
  window.novela.onServerStatus((st) => {
    serverState = st || serverState;
    renderServerStatus();
  });

  applyTheme();
  applyI18n();
  $('logList').innerHTML = `<div class="log-empty">${t('log.empty')}</div>`;
  renderLogCount();
  initMonaco();
  refreshBackend();
  loadServerCfg();
}

document.addEventListener('DOMContentLoaded', init);
