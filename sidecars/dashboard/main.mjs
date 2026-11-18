import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarApp } from 'sidecar_sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ID_RE = /^[0-9a-f-]{8,}$/i;
const DEFAULT_CONTEXT_LIMIT = 1_000_000;
const DAY_MS = 86_400_000;
const DEFAULT_MODEL_NAME = '默认模型';
const MODEL_PALETTE = [
  '#4f46e5',
  '#0ea5e9',
  '#10b981',
  '#f59e0b',
  '#ec4899',
  '#8b5cf6',
  '#14b8a6',
  '#ef4444',
  '#84cc16',
  '#f97316',
  '#06b6d4',
  '#6366f1',
];

const MODEL_ALIAS_MAP = new Map([
  ['gemini-3.8-flash-tiered', 'Gemini 3.8 Flash'],
  ['gemini-3.8-flash-n', 'Gemini 3.8 Flash'],
  ['gemini-4-hydrogen', 'Gemini 4 Hydrogen'],
  ['gemini-pro-orchestrator-g1-pro', 'Orchestrator (Argon)'],
  ['gemini-flash-worker-agy', 'Gemini 4 Hydrogen (Orchestrator)'],
]);

// In-memory cache keyed by transcript path -> { key, convId, path, mtimeMs, hasExplicitStepModels, title, currentModel, steps }
const transcriptCache = new Map();
// In-memory RPC metadata cache keyed by convId -> { key, stepModels: Record<string, string>, maxContextTokens: number }
const genMetaCache = loadDiskMetaCache();
let diskCacheDirty = false;

function getMetaCachePath() {
  const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (!dataDir) return '';
  return join(dataDir, 'gen_meta_cache.json');
}

function loadDiskMetaCache() {
  const map = new Map();
  const p = getMetaCachePath();
  if (!p || !existsSync(p)) return map;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8'));
    if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw)) {
        if (v && typeof v === 'object' && v.key) {
          map.set(k, {
            key: String(v.key),
            stepModels: v.stepModels && typeof v.stepModels === 'object' ? v.stepModels : {},
            maxContextTokens: Number(v.maxContextTokens) || 0,
          });
        }
      }
    }
  } catch {}
  return map;
}

function saveDiskMetaCache() {
  if (!diskCacheDirty) return;
  const p = getMetaCachePath();
  if (!p) return;
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(Object.fromEntries(genMetaCache)), 'utf-8');
    diskCacheDirty = false;
  } catch {}
}

export function findBrainDirs() {
  const seen = new Set();
  const dirs = [];
  const addDir = (p) => {
    if (!p || !existsSync(p)) return;
    try {
      const real = realpathSync(p);
      if (seen.has(real)) return;
      seen.add(real);
      dirs.push(real);
    } catch {}
  };

  const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (dataDir) {
    for (let d = dataDir; d !== dirname(d); d = dirname(d)) {
      const base = basename(d);
      if (base === 'sidecar_data' || base === 'plugin_data') {
        addDir(join(dirname(d), 'brain'));
      }
    }
  }

  const root = join(homedir(), '.gemini');
  try {
    for (const name of readdirSync(root)) {
      addDir(join(root, name, 'brain'));
    }
  } catch {}

  return dirs;
}

function getLocalParts(ms, tzOffsetMinutes) {
  if (!Number.isFinite(ms)) return null;
  if (Number.isFinite(tzOffsetMinutes)) {
    const local = new Date(ms - tzOffsetMinutes * 60_000);
    return {
      year: local.getUTCFullYear(),
      month: local.getUTCMonth() + 1,
      day: local.getUTCDate(),
      hour: local.getUTCHours(),
    };
  }
  const local = new Date(ms);
  return {
    year: local.getFullYear(),
    month: local.getMonth() + 1,
    day: local.getDate(),
    hour: local.getHours(),
  };
}

export function toLocalDateKey(ms, tzOffsetMinutes) {
  const p = getLocalParts(ms, tzOffsetMinutes);
  if (!p) return '';
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function toLocalHourKey(ms, tzOffsetMinutes) {
  const p = getLocalParts(ms, tzOffsetMinutes);
  if (!p) return '';
  return String(p.hour).padStart(2, '0');
}

function formatDayLabel(dateKey) {
  const [, m, d] = dateKey.split('-');
  return `${Number(m)}/${Number(d)}`;
}

function shiftDateKey(baseDateKey, deltaDays) {
  const [y, m, d] = baseDateKey.split('-').map(Number);
  const utc = Date.UTC(y, m - 1, d) + deltaDays * DAY_MS;
  const shifted = new Date(utc);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

function extractTitleFromUserInput(content, convId) {
  const fallback = `会话 ${convId.slice(0, 8)}`;
  if (typeof content !== 'string' || !content.trim()) return fallback;
  const reqMatch = content.match(/<USER_REQUEST>\s*([\s\S]*?)(?:<\/USER_REQUEST>|$)/i);
  const body = reqMatch ? reqMatch[1] : content;
  const cleaned = body.replace(/<\/?[A-Z_]+>/g, ' ').trim();
  const firstLine = cleaned
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return fallback;
  return firstLine.length > 36 ? `${firstLine.slice(0, 36)}…` : firstLine;
}

function extractModelChange(content) {
  if (typeof content !== 'string' || !content.includes('Model Selection')) return null;
  const match = content.match(/changed setting [`'"]?Model Selection[`'"]? from (.+?) to (.+?)(?:\.(?:\s|$)|\n|$)/i);
  if (!match) return null;
  const fromModel = match[1].trim();
  const toModel = match[2].trim();
  return {
    fromModel: fromModel && fromModel !== 'None' ? fromModel : '',
    toModel: toModel && toModel !== 'None' ? toModel : '',
  };
}

function slugKey(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function normalizeModelName(raw, displayHint = '') {
  const s = String(raw || '').trim();
  if (!s) return displayHint || '';
  if (MODEL_ALIAS_MAP.has(s)) return MODEL_ALIAS_MAP.get(s);
  if (displayHint && slugKey(displayHint) === slugKey(s)) {
    return displayHint;
  }
  if (/[A-Z\s]/.test(s)) return s;
  const tokens = s.split('-');
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    if (/^\d+$/.test(t) && i + 1 < tokens.length && /^\d+$/.test(tokens[i + 1])) {
      out.push(`${t}.${tokens[i + 1]}`);
      i += 1;
      continue;
    }
    if (['high', 'xhigh', 'medium', 'low', 'thinking', 'fast'].includes(t) && i === tokens.length - 1) {
      const label = t === 'xhigh' ? 'XHigh' : t[0].toUpperCase() + t.slice(1);
      out.push(`(${label})`);
      continue;
    }
    out.push(t[0].toUpperCase() + t.slice(1));
  }
  return out.join(' ');
}

export function parseTranscriptFile(transcriptPath, convId) {
  let stat;
  try {
    stat = statSync(transcriptPath);
  } catch {
    return null;
  }

  const cacheKey = `${stat.mtimeMs}:${stat.size}`;
  const cached = transcriptCache.get(transcriptPath);
  if (cached && cached.key === cacheKey) {
    return cached;
  }

  let raw = '';
  try {
    raw = readFileSync(transcriptPath, 'utf-8');
  } catch {
    return null;
  }

  let title = '';
  let currentModel = '';
  let explicitCount = 0;
  const steps = [];

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }

    if (row.type === 'USER_INPUT') {
      if (!title) {
        title = extractTitleFromUserInput(row.content, convId);
      }
      const change = extractModelChange(row.content);
      if (change) {
        if (!currentModel && change.fromModel) {
          for (const s of steps) {
            if (!s.model) s.model = change.fromModel;
          }
        }
        if (change.toModel) {
          currentModel = change.toModel;
        }
      }
    }

    if (row.type === 'PLANNER_RESPONSE') {
      const inp = Number(row.input_tokens) || 0;
      const cache = Number(row.cache_read_tokens) || 0;
      const out = Number(row.output_tokens) || 0;
      const parsedMs = row.created_at ? Date.parse(row.created_at) : NaN;
      const ts = Number.isFinite(parsedMs) ? parsedMs : stat.mtimeMs;
      const rawExplicit = typeof row.model === 'string' && row.model.trim()
        ? row.model.trim()
        : (typeof row.model_name === 'string' && row.model_name.trim() ? row.model_name.trim() : '');
      if (rawExplicit) explicitCount += 1;
      const model = rawExplicit
        ? normalizeModelName(rawExplicit, currentModel)
        : (currentModel || '');

      steps.push({
        step: Number(row.step_index),
        time: row.created_at || '',
        ts,
        model,
        input: inp,
        cache,
        output: out,
        context: inp + cache + out,
      });
    }
  }

  const parsed = {
    key: cacheKey,
    convId,
    path: transcriptPath,
    mtimeMs: stat.mtimeMs,
    hasExplicitStepModels: steps.length > 0 && explicitCount === steps.length,
    title: title || `会话 ${convId.slice(0, 8)}`,
    currentModel: currentModel || '',
    steps,
  };
  transcriptCache.set(transcriptPath, parsed);
  return parsed;
}

async function fetchGeneratorMetadata(convId, cacheKey) {
  const cached = genMetaCache.get(convId);
  if (cached && cached.key === cacheKey) {
    return cached;
  }

  const lsAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
  const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
  if (!lsAddr || !csrf) return null;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  if (typeof timer.unref === 'function') timer.unref();

  try {
    const res = await fetch(
      `http://${lsAddr}/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-codeium-csrf-token': csrf,
        },
        body: JSON.stringify({ cascadeId: convId }),
        signal: ctrl.signal,
      }
    );
    if (!res.ok) return null;
    const json = await res.json();
    const list = Array.isArray(json?.generatorMetadata) ? json.generatorMetadata : [];
    const stepModels = {};
    let maxContextTokens = 0;

    for (const item of list) {
      const cm = item?.chatModel;
      if (!cm) continue;
      const display = typeof cm.modelDisplayName === 'string' && cm.modelDisplayName.trim()
        ? cm.modelDisplayName.trim()
        : '';
      const resp = typeof cm.responseModel === 'string' && cm.responseModel.trim()
        ? cm.responseModel.trim()
        : '';
      const resolvedModel = display || normalizeModelName(resp);
      const maxCtx = Number(cm.chatStartMetadata?.contextWindowMetadata?.maxContextTokens) || 0;
      if (maxCtx > 0) maxContextTokens = maxCtx;

      if (resolvedModel && Array.isArray(item.stepIndices)) {
        for (const idx of item.stepIndices) {
          stepModels[String(Number(idx))] = resolvedModel;
        }
      }
    }

    const entry = { key: cacheKey, stepModels, maxContextTokens };
    genMetaCache.set(convId, entry);
    diskCacheDirty = true;
    return entry;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function enrichTranscripts(transcripts) {
  if (!process.env.ANTIGRAVITY_LS_ADDRESS || !process.env.ANTIGRAVITY_CSRF_TOKEN) {
    return;
  }
  const queue = transcripts.filter((tr) => {
    if (tr.hasExplicitStepModels || tr.path.includes(`${sep}antigravity-cli${sep}`)) {
      return false;
    }
    const cached = genMetaCache.get(tr.convId);
    return !cached || cached.key !== tr.key;
  });
  if (!queue.length) return;

  const CONCURRENCY = 6;
  for (let i = 0; i < queue.length; i += CONCURRENCY) {
    await Promise.all(queue.slice(i, i + CONCURRENCY).map((tr) => fetchGeneratorMetadata(tr.convId, tr.key)));
  }
  saveDiskMetaCache();
}

function resolveStepModel(step, meta) {
  const rpcModel = meta?.stepModels?.[String(Number(step.step))];
  return rpcModel || step.model || DEFAULT_MODEL_NAME;
}

function listAllTranscripts(brains) {
  const byId = new Map();
  for (const brain of brains) {
    let entries = [];
    try {
      entries = readdirSync(brain);
    } catch {
      continue;
    }
    for (const id of entries) {
      if (!ID_RE.test(id)) continue;
      const transcriptPath = join(brain, id, '.system_generated', 'logs', 'transcript.jsonl');
      if (!existsSync(transcriptPath)) continue;
      const parsed = parseTranscriptFile(transcriptPath, id);
      if (!parsed) continue;
      const prev = byId.get(id);
      if (!prev || parsed.mtimeMs > prev.mtimeMs) {
        byId.set(id, parsed);
      }
    }
  }
  return [...byId.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function findSingleTranscript(convId, brains) {
  if (convId && ID_RE.test(convId)) {
    for (const brain of brains) {
      const p = join(brain, convId, '.system_generated', 'logs', 'transcript.jsonl');
      if (existsSync(p)) {
        const parsed = parseTranscriptFile(p, convId);
        if (parsed) return parsed;
      }
    }
  }
  const all = listAllTranscripts(brains);
  return all[0] || null;
}

function buildDailyRangeKeys(minDateKey, maxDateKey) {
  const keys = [];
  let cursor = minDateKey;
  let guard = 0;
  while (cursor <= maxDateKey && guard < 366) {
    keys.push(cursor);
    cursor = shiftDateKey(cursor, 1);
    guard += 1;
  }
  return keys;
}

export async function computeStats({
  mode = 'current',
  conversationId = '',
  range = 'all',
  model = '',
  tzOffset = null,
  brains = null,
  nowMs = Date.now(),
} = {}) {
  const activeMode = mode === 'all' ? 'all' : 'current';
  const tzNum = tzOffset !== null && tzOffset !== '' && Number.isFinite(Number(tzOffset)) ? Number(tzOffset) : undefined;
  const brainDirs = Array.isArray(brains) ? brains : findBrainDirs();

  if (activeMode === 'current') {
    const requestedId = typeof conversationId === 'string' && ID_RE.test(conversationId.trim()) ? conversationId.trim() : '';
    const target = findSingleTranscript(requestedId, brainDirs);

    if (!target) {
      return {
        mode: 'current',
        conversationId: requestedId || null,
        title: '',
        model: DEFAULT_MODEL_NAME,
        contextUsed: 0,
        contextLimit: DEFAULT_CONTEXT_LIMIT,
        cacheHitRate: 0,
        totalInput: 0,
        totalCache: 0,
        totalOutput: 0,
        stepCount: 0,
        steps: [],
      };
    }

    const meta = target.hasExplicitStepModels
      ? null
      : await fetchGeneratorMetadata(target.convId, target.key);
    saveDiskMetaCache();

    let totalInput = 0;
    let totalCache = 0;
    let totalOutput = 0;
    const resolvedSteps = target.steps.map((s) => {
      totalInput += s.input;
      totalCache += s.cache;
      totalOutput += s.output;
      return { ...s, model: resolveStepModel(s, meta) };
    });

    const last = resolvedSteps[resolvedSteps.length - 1] || {
      input: 0,
      cache: 0,
      output: 0,
      context: 0,
      model: target.currentModel || DEFAULT_MODEL_NAME,
    };
    const promptTotal = last.input + last.cache;
    const cacheHitRate = promptTotal > 0 ? Math.round((last.cache / promptTotal) * 100) : 0;
    const contextLimit = meta?.maxContextTokens > 0 ? meta.maxContextTokens : DEFAULT_CONTEXT_LIMIT;

    return {
      mode: 'current',
      conversationId: target.convId,
      title: target.title,
      model: last.model || target.currentModel || DEFAULT_MODEL_NAME,
      contextUsed: last.context,
      contextLimit,
      cacheHitRate,
      totalInput,
      totalCache,
      totalOutput,
      stepCount: resolvedSteps.length,
      steps: resolvedSteps.slice(-50),
    };
  }

  // mode === 'all'
  const activeRange = ['all', 'today', '7d', '30d'].includes(range) ? range : 'all';
  const todayKey = toLocalDateKey(nowMs, tzNum);
  const startKey = activeRange === 'today'
    ? todayKey
    : activeRange === '7d'
      ? shiftDateKey(todayKey, -6)
      : activeRange === '30d'
        ? shiftDateKey(todayKey, -29)
        : '';

  const transcripts = listAllTranscripts(brainDirs);
  await enrichTranscripts(transcripts);

  const rangeSteps = [];
  const activeConvsInRange = new Set();

  for (const tr of transcripts) {
    const meta = genMetaCache.get(tr.convId);
    for (const s of tr.steps) {
      const dateKey = toLocalDateKey(s.ts, tzNum);
      if (startKey && (dateKey < startKey || dateKey > todayKey)) continue;
      rangeSteps.push({
        ...s,
        model: resolveStepModel(s, meta),
        convId: tr.convId,
        dateKey,
        hourKey: toLocalHourKey(s.ts, tzNum),
      });
      activeConvsInRange.add(tr.convId);
    }
  }

  const modelMap = new Map();
  let rangeGrandTotal = 0;

  for (const s of rangeSteps) {
    const name = s.model || DEFAULT_MODEL_NAME;
    let entry = modelMap.get(name);
    if (!entry) {
      entry = {
        model: name,
        requests: 0,
        inputTokens: 0,
        cacheTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      };
      modelMap.set(name, entry);
    }
    const stepTotal = s.input + s.cache + s.output;
    entry.requests += 1;
    entry.inputTokens += s.input;
    entry.cacheTokens += s.cache;
    entry.outputTokens += s.output;
    entry.totalTokens += stepTotal;
    rangeGrandTotal += stepTotal;
  }

  const models = [...modelMap.values()]
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .map((m, idx) => {
      const prompt = m.inputTokens + m.cacheTokens;
      return {
        ...m,
        color: MODEL_PALETTE[idx % MODEL_PALETTE.length],
        cacheHitRate: prompt > 0 ? Math.round((m.cacheTokens / prompt) * 100) : 0,
        sharePct: rangeGrandTotal > 0 ? Math.round((m.totalTokens / rangeGrandTotal) * 1000) / 10 : 0,
      };
    });

  const modelFilter = typeof model === 'string' && modelMap.has(model) ? model : '';
  const filteredSteps = modelFilter ? rangeSteps.filter((s) => s.model === modelFilter) : rangeSteps;

  let totalInput = 0;
  let totalCache = 0;
  let totalOutput = 0;
  const filteredConvs = new Set();
  for (const s of filteredSteps) {
    totalInput += s.input;
    totalCache += s.cache;
    totalOutput += s.output;
    filteredConvs.add(s.convId);
  }
  const totalTokens = totalInput + totalCache + totalOutput;
  const totalPrompt = totalInput + totalCache;
  const cacheHitRate = totalPrompt > 0 ? Math.round((totalCache / totalPrompt) * 100) : 0;

  const granularity = activeRange === 'today' ? 'hour' : 'day';
  let bucketKeys = [];
  if (granularity === 'hour') {
    bucketKeys = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));
  } else if (activeRange === '7d' || activeRange === '30d') {
    bucketKeys = buildDailyRangeKeys(startKey, todayKey);
  } else {
    let minKey = todayKey;
    let maxKey = todayKey;
    for (const s of rangeSteps) {
      if (s.dateKey && s.dateKey < minKey) minKey = s.dateKey;
      if (s.dateKey && s.dateKey > maxKey) maxKey = s.dateKey;
    }
    const minWindowStart = shiftDateKey(maxKey, -6);
    if (minKey > minWindowStart) minKey = minWindowStart;
    bucketKeys = buildDailyRangeKeys(minKey, maxKey);
    if (bucketKeys.length > 90) {
      bucketKeys = bucketKeys.slice(-90);
    }
  }

  const bucketMap = new Map();
  for (const key of bucketKeys) {
    bucketMap.set(key, {
      key,
      label: granularity === 'hour' ? `${key}:00` : formatDayLabel(key),
      total: 0,
      byModel: {},
    });
  }

  for (const s of filteredSteps) {
    const bKey = granularity === 'hour' ? s.hourKey : s.dateKey;
    const bucket = bucketMap.get(bKey);
    if (!bucket) continue;
    const stepTotal = s.input + s.cache + s.output;
    bucket.total += stepTotal;
    const mName = s.model || DEFAULT_MODEL_NAME;
    bucket.byModel[mName] = (bucket.byModel[mName] || 0) + stepTotal;
  }

  return {
    mode: 'all',
    range: activeRange,
    selectedModel: modelFilter,
    granularity,
    totalTokens,
    totalInput,
    totalCache,
    totalOutput,
    cacheHitRate,
    stepCount: filteredSteps.length,
    conversationCount: filteredConvs.size,
    totalConversationCount: activeConvsInRange.size,
    models,
    buckets: bucketKeys.map((k) => bucketMap.get(k)),
  };
}

function isMainModule() {
  try {
    if (!process.argv[1]) return false;
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const app = new SidecarApp();
  app.page('/', () => readFileSync(join(__dirname, 'index.html'), 'utf-8'));
  app.api('/api/tokens', async (data) => {
    const convId = typeof data.conversationId === 'string' && data.conversationId.trim()
      ? data.conversationId.trim()
      : app.config.conversationId;
    return computeStats({
      mode: data.mode,
      conversationId: convId,
      range: data.range,
      model: data.model,
      tzOffset: data.tzOffset,
    });
  }, 'GET');
  app.run();
}
