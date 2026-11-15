'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const FLOW_HOME_URL = 'https://flow.google.com/';
const DEFAULT_CDP_PORT = Number(process.env.FLOW_CDP_PORT || 9222);

function getStateDir() {
  return process.env.FLOW_CLI_HOME || path.join(os.homedir(), '.google-flow-cli');
}

function getChromeProfileDir() {
  return path.join(getStateDir(), 'chrome-profile');
}

function getStatePath() {
  return path.join(getStateDir(), 'state.json');
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function defaultState() {
  return {
    cdpPort: DEFAULT_CDP_PORT,
    cdpUrl: `http://127.0.0.1:${DEFAULT_CDP_PORT}`,
    flowUrl: FLOW_HOME_URL,
    currentProject: null,
    projects: {},
    stagedDrafts: [],
    promptQueue: [],
  };
}

function loadState() {
  const statePath = getStatePath();
  if (!fs.existsSync(statePath)) {
    return defaultState();
  }
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      ...defaultState(),
      ...parsed,
      projects: parsed.projects && typeof parsed.projects === 'object' ? parsed.projects : {},
      stagedDrafts: Array.isArray(parsed.stagedDrafts) ? parsed.stagedDrafts : [],
      promptQueue: Array.isArray(parsed.promptQueue) ? parsed.promptQueue : [],
    };
  } catch {
    return defaultState();
  }
}

function saveState(state) {
  ensureDir(getStateDir());
  const next = {
    ...defaultState(),
    ...state,
    cdpPort: Number(state.cdpPort || DEFAULT_CDP_PORT),
    cdpUrl: `http://127.0.0.1:${Number(state.cdpPort || DEFAULT_CDP_PORT)}`,
  };
  fs.writeFileSync(getStatePath(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function extractProjectIdFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const projectMatch = url.match(/\/project\/([a-zA-Z0-9_-]+)/i) || url.match(/\/projects\/([a-zA-Z0-9_-]+)/i);
  if (projectMatch) return projectMatch[1];
  try {
    const parsed = new URL(url);
    const paramId = parsed.searchParams.get('projectId') || parsed.searchParams.get('project');
    if (paramId) return paramId;
  } catch {
    // Ignore non-URL strings
  }
  return null;
}

function upsertProjectRecord(project) {
  if (!project || !project.projectId) return loadState();
  const state = loadState();
  const existing = state.projects[project.projectId] || {};
  state.projects[project.projectId] = {
    ...existing,
    ...project,
    updatedAt: new Date().toISOString(),
  };
  return saveState(state);
}

function setCurrentProject(project) {
  const state = loadState();
  const now = new Date().toISOString();
  const cleanTitle =
    String(project.title || '')
      .replace(/^Google Flow\s*-\s*/i, '')
      .trim() || 'Untitled Flow Project';
  const entry = {
    projectId: project.projectId || extractProjectIdFromUrl(project.webUrl) || 'active',
    title: cleanTitle,
    webUrl: project.webUrl || FLOW_HOME_URL,
    updatedAt: now,
  };
  state.currentProject = entry;
  state.projects[entry.projectId] = {
    ...(state.projects[entry.projectId] || {}),
    ...entry,
  };
  return saveState(state);
}

function recordStagedDraft(draft) {
  const state = loadState();
  const record = {
    id: `draft_${Date.now()}`,
    stagedAt: new Date().toISOString(),
    ...draft,
  };
  state.stagedDrafts = [record, ...state.stagedDrafts].slice(0, 50);
  saveState(state);
  return record;
}

function summarizeQueue(items) {
  const counts = { total: items.length, pending: 0, staged: 0, submitted: 0 };
  for (const item of items) {
    if (item.status === 'staged') counts.staged += 1;
    else if (item.status === 'submitted') counts.submitted += 1;
    else counts.pending += 1;
  }
  return counts;
}

function enqueuePromptItems(items) {
  const list = Array.isArray(items) ? items : [items];
  const state = loadState();
  const baseTs = Date.now();
  const nowIso = new Date().toISOString();
  const created = list.map((item, idx) => ({
    id: `queue_${baseTs}_${idx}`,
    createdAt: nowIso,
    status: item.status || 'pending',
    title: item.title || null,
    prompt: String(item.prompt || ''),
    uploads: Array.isArray(item.uploads) ? item.uploads : [],
    assets: Array.isArray(item.assets) ? item.assets : [],
    voice: item.voice || '',
    voiceDialog: item.voiceDialog || '',
    voiceStyle: item.voiceStyle || '',
    voiceSaveName: item.voiceSaveName || '',
    mode: item.mode || '',
  }));
  state.promptQueue = [...state.promptQueue, ...created];
  saveState(state);
  return {
    added: created,
    summary: summarizeQueue(state.promptQueue),
    items: state.promptQueue,
  };
}

function getPromptQueue() {
  const state = loadState();
  return {
    summary: summarizeQueue(state.promptQueue),
    items: state.promptQueue,
  };
}

function updateQueueItem(id, patch) {
  const state = loadState();
  const idx = state.promptQueue.findIndex((q) => q.id === id);
  if (idx === -1) return null;
  state.promptQueue[idx] = {
    ...state.promptQueue[idx],
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  saveState(state);
  return state.promptQueue[idx];
}

function findQueueItem(target = 'current') {
  const state = loadState();
  const items = state.promptQueue;
  if (!items.length) return null;

  const raw = target === undefined || target === null ? 'current' : String(target).trim();
  const lower = raw.toLowerCase();
  if (!raw || lower === 'current' || lower === 'staged') {
    return items.find((q) => q.status === 'staged') || items.find((q) => q.status === 'pending') || null;
  }

  const byId = items.find((q) => q.id === raw);
  if (byId) return byId;

  if (/^\d+$/.test(raw)) {
    const oneBased = Number(raw);
    if (oneBased >= 1 && oneBased <= items.length) {
      return items[oneBased - 1];
    }
  }

  return items.find((q) => q.title && q.title.toLowerCase().includes(lower)) || null;
}

function clearPromptQueue({ completedOnly = false } = {}) {
  const state = loadState();
  const before = state.promptQueue.length;
  state.promptQueue = completedOnly
    ? state.promptQueue.filter((q) => q.status !== 'submitted')
    : [];
  saveState(state);
  return {
    removedCount: before - state.promptQueue.length,
    summary: summarizeQueue(state.promptQueue),
    items: state.promptQueue,
  };
}

module.exports = {
  FLOW_HOME_URL,
  DEFAULT_CDP_PORT,
  getStateDir,
  getChromeProfileDir,
  getStatePath,
  ensureDir,
  loadState,
  saveState,
  extractProjectIdFromUrl,
  upsertProjectRecord,
  setCurrentProject,
  recordStagedDraft,
  enqueuePromptItems,
  getPromptQueue,
  updateQueueItem,
  findQueueItem,
  clearPromptQueue,
};
