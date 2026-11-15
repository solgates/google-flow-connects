'use strict';

const fs = require('fs');
const path = require('path');
const {
  FLOW_HOME_URL,
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
} = require('./state');
const { withFlowPage, isCdpReachable } = require('./browser');
const { VOICES, findVoices, resolveVoiceExact, normalizeCategoryKey, ASSET_CATEGORIES } = require('./catalog');
const {
  MAX_DIALOG_LENGTH,
  detectAuthAndPageState,
  readComposerState,
  inspectPageDom,
  listProjectsFromUi,
  createNewProjectInUi,
  closeAssetDrawerIfOpen,
  openAssetTab,
  searchAssetsInDrawer,
  readVisibleAssets,
  uploadFilesInUi,
  attachAssetInUi,
  configureVoiceInUi,
  selectComposerModeInUi,
  clearPromptInUi,
  stagePromptInUi,
} = require('./selectors');
const pkg = require('../package.json');

const EXIT_CODES = {
  OK: 0,
  ERROR: 1,
  VALIDATION: 2,
  LOGIN_REQUIRED: 11,
  GUARDRAIL_BLOCKED: 13,
};

class CliError extends Error {
  constructor(message, exitCode = EXIT_CODES.ERROR, details = null) {
    super(message);
    this.exitCode = exitCode;
    this.details = details;
  }
}

const SCHEMA_DEFINITION = {
  schemaVersion: '2',
  name: 'flow-canvas',
  aliases: ['google-flow'],
  version: pkg.version,
  guardrail: {
    manualGenerateOnly: true,
    blockedFlags: ['--run', '--submit'],
    blockedSubcommands: ['node run', 'node confirm', 'prompt run', 'prompt submit'],
    exitCodeOnBlock: EXIT_CODES.GUARDRAIL_BLOCKED,
    reason:
      'Google Flow Manual Generate Guard: CLI stages projects, uploads assets, configures voices, and populates prompts without clicking Generate. Only the user triggers generation inside the browser.',
  },
  exitCodes: EXIT_CODES,
  commands: {
    version: { description: 'Print CLI version and runtime info.' },
    schema: { description: 'Print machine-readable command schema (schemaVersion "2").', args: ['[command]'] },
    'auth status': { description: 'Ensure Chrome CDP is running on Google Flow and check login state.' },
    'auth login': { description: 'Open Google Flow in the persistent Chrome profile so the user can sign in.' },
    'project ls': {
      aliases: ['canvas ls'],
      description: 'List discovered Google Flow projects from the active UI and local state.',
    },
    'project create': {
      aliases: ['canvas create'],
      description: 'Create a new Google Flow project and set it as active.',
      flags: ['--title <name>'],
    },
    'project use': {
      aliases: ['canvas use'],
      description: 'Navigate to an existing Google Flow project by projectId, title, or URL.',
      args: ['<id-or-url>'],
    },
    'project current': {
      aliases: ['canvas current'],
      description: 'Inspect the currently active project and composer state.',
    },
    'project inspect': {
      aliases: ['canvas inspect'],
      description: 'Return a live DOM summary (buttons, tabs, inputs, file inputs) for diagnostics.',
    },
    'asset ls': {
      aliases: ['resource ls'],
      description: 'List visible assets in the Flow asset drawer.',
      flags: ['--category <semua|gambar|video|suara|karakter|avatar|uploaded>', '--query <text>'],
    },
    'asset upload': {
      aliases: ['resource upload'],
      description: 'Upload one or more local material assets into Google Flow.',
      args: ['<file...>'],
      flags: ['--category <uploaded|karakter|avatar>'],
    },
    'asset attach': {
      aliases: ['resource attach'],
      description: 'Find an existing asset in the drawer and attach it to the prompt.',
      args: ['<name-or-query>'],
      flags: ['--category <semua|gambar|video|suara|karakter|avatar|uploaded>'],
    },
    'voice list': {
      aliases: ['voice ls'],
      description: 'List available Google Flow voices (Suara).',
      flags: ['--query <text>', '--live'],
    },
    'voice add': {
      description: 'Select a voice in Suara, fill Contoh dialog & Sesuaikan performa, and click Tambahkan ke perintah.',
      flags: ['--name <voice>', '--dialog <text>', '--style <text>', '--preview'],
    },
    'voice preview': {
      description: 'Select a voice in Suara, optionally set dialog/style, and click Pratinjau without adding.',
      flags: ['--name <voice>', '--dialog <text>', '--style <text>'],
    },
    'prompt stage': {
      aliases: ['node create', 'node edit'],
      description:
        'Upload material assets, attach assets, configure optional voice, and stage prompt text into the Google Flow composer without clicking Generate.',
      args: ['[prompt]'],
      flags: [
        '--prompt <text>',
        '--title <label>',
        '--upload <path> (repeatable)',
        '--asset <name> (repeatable)',
        '--voice <name>',
        '--voice-dialog <text>',
        '--voice-style <text>',
        '--mode <image|video>',
        '--clear',
        '--enqueue',
      ],
    },
    'queue add': {
      description: 'Add a prompt + materials shot to the single-tab auto-refill queue (optionally pre-upload assets).',
      args: ['[prompt]'],
      flags: [
        '--prompt <text>',
        '--title <label>',
        '--upload <path> (repeatable)',
        '--asset <name> (repeatable)',
        '--voice <name>',
        '--voice-dialog <text>',
        '--voice-style <text>',
        '--mode <image|video>',
        '--preupload',
      ],
    },
    'queue ls': {
      aliases: ['queue status'],
      description: 'List queued shots and their status (pending, staged, submitted).',
    },
    'queue next': {
      description: 'Mark any current staged item submitted and immediately stage the next pending item.',
    },
    'queue edit': {
      aliases: ['queue update'],
      description:
        'Revise prompt, title, uploads, assets, voice, or mode for the current staged shot or another queued shot (auto-restages if staged).',
      args: ['[target]'],
      flags: [
        '--current',
        '--id <queueId>',
        '--prompt <text>',
        '--title <label>',
        '--upload <path> (repeatable, replaces uploads)',
        '--add-upload <path> (repeatable, appends uploads)',
        '--asset <name> (repeatable)',
        '--voice <name>',
        '--voice-dialog <text>',
        '--voice-style <text>',
        '--mode <image|video>',
        '--preupload',
        '--restage',
        '--no-restage',
      ],
    },
    'queue retry': {
      aliases: ['queue restage'],
      description: 'Re-stage the current staged shot or a matching queue item in Chrome without advancing the queue.',
      args: ['[target]'],
      flags: ['--id <queueId>'],
    },
    'queue watch': {
      aliases: ['queue start'],
      description:
        'Pre-upload queued materials and watch the active tab composer; automatically refills the next shot whenever the user clicks Generate.',
      flags: ['--poll-ms <ms>', '--timeout <minutes>'],
    },
    'queue clear': {
      description: 'Clear all queued items (or pass --completed to remove only submitted items).',
      flags: ['--completed'],
    },
    mcp: {
      description: 'Start the stdio JSON-RPC 2.0 MCP server for Antigravity and Kiro.',
    },
  },
};

function checkManualGuardrail(flags, positionals) {
  if (flags.run || flags.submit) {
    throw new CliError(
      'Google Flow Manual Generate Guard: blocked `--run` / `--submit`. Stage assets, voices, and prompts without `--run` so only the user clicks Generate inside the Google Flow web UI.',
      EXIT_CODES.GUARDRAIL_BLOCKED,
      { blockedFlag: flags.run ? '--run' : '--submit' }
    );
  }
  const c0 = (positionals[0] || '').toLowerCase();
  const c1 = (positionals[1] || '').toLowerCase();
  if ((c0 === 'node' || c0 === 'prompt') && (c1 === 'run' || c1 === 'confirm' || c1 === 'submit')) {
    throw new CliError(
      `Google Flow Manual Generate Guard: blocked \`${c0} ${c1}\`. Only staging is permitted; let the user click Generate inside the Google Flow web UI.`,
      EXIT_CODES.GUARDRAIL_BLOCKED,
      { blockedCommand: `${c0} ${c1}` }
    );
  }
}

async function cmdVersion() {
  const state = loadState();
  const cdpInfo = await isCdpReachable(state.cdpUrl);
  return {
    name: 'flow-canvas',
    version: pkg.version,
    node: process.version,
    cdpUrl: state.cdpUrl,
    cdpRunning: Boolean(cdpInfo),
    currentProject: state.currentProject,
  };
}

function cmdSchema(targetCommand) {
  if (!targetCommand) return SCHEMA_DEFINITION;
  const key = String(targetCommand).trim().toLowerCase();
  const direct = SCHEMA_DEFINITION.commands[key];
  if (direct) {
    return { schemaVersion: '2', command: key, spec: direct, guardrail: SCHEMA_DEFINITION.guardrail };
  }
  const byAlias = Object.entries(SCHEMA_DEFINITION.commands).find(
    ([, spec]) => Array.isArray(spec.aliases) && spec.aliases.includes(key)
  );
  if (byAlias) {
    return { schemaVersion: '2', command: byAlias[0], spec: byAlias[1], guardrail: SCHEMA_DEFINITION.guardrail };
  }
  throw new CliError(`Unknown schema command: ${targetCommand}`, EXIT_CODES.VALIDATION);
}

async function cmdAuthStatus({ bringToFront = false } = {}) {
  return withFlowPage({ bringToFront }, async ({ page, launched, cdpUrl }) => {
    const status = await detectAuthAndPageState(page);
    if (status.projectId) {
      setCurrentProject({
        projectId: status.projectId,
        title: status.headingText || status.title,
        webUrl: status.url,
      });
    }
    return {
      launchedBrowser: launched,
      cdpUrl,
      ...status,
      actionRequired: status.needsLogin
        ? 'Sign in to your Google account inside the opened Chrome window, then re-run your command.'
        : null,
    };
  });
}

async function cmdProjectList() {
  return withFlowPage({}, async ({ context, page }) => {
    const auth = await detectAuthAndPageState(page);
    if (auth.needsLogin) {
      throw new CliError(
        `Google sign-in required in Chrome (${auth.url}). Complete sign-in and re-run.`,
        EXIT_CODES.LOGIN_REQUIRED,
        auth
      );
    }

    let uiProjects = [];
    if (auth.inProject) {
      const homeTab = await context.newPage();
      try {
        await homeTab.goto(FLOW_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await homeTab.waitForSelector('.project-card', { timeout: 6000 }).catch(() => {});
        uiProjects = await listProjectsFromUi(homeTab);
      } finally {
        await homeTab.close().catch(() => {});
      }
    } else {
      await page.waitForSelector('.project-card', { timeout: 5000 }).catch(() => {});
      uiProjects = await listProjectsFromUi(page);
    }

    for (const p of uiProjects) {
      upsertProjectRecord(p);
    }

    const refreshed = loadState();
    const mergedMap = new Map();
    for (const p of Object.values(refreshed.projects)) {
      mergedMap.set(p.projectId, p);
    }
    for (const p of uiProjects) {
      mergedMap.set(p.projectId, { ...(mergedMap.get(p.projectId) || {}), ...p });
    }

    return {
      currentProject: refreshed.currentProject,
      activeUrl: auth.url,
      projects: Array.from(mergedMap.values()),
    };
  });
}

async function cmdProjectCreate({ title } = {}) {
  return withFlowPage({ bringToFront: true }, async ({ page }) => {
    const auth = await detectAuthAndPageState(page);
    if (auth.needsLogin) {
      throw new CliError(
        `Google sign-in required in Chrome (${auth.url}). Complete sign-in first.`,
        EXIT_CODES.LOGIN_REQUIRED,
        auth
      );
    }

    if (auth.inProject) {
      await page.goto(FLOW_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(1000);
    }

    const created = await createNewProjectInUi(page, title);
    const nextState = setCurrentProject(created);
    return {
      created: true,
      project: nextState.currentProject,
      clickedLabel: created.clickedLabel,
    };
  });
}

async function cmdProjectUse(target) {
  if (!target) {
    throw new CliError('Missing project ID, title, or URL. Usage: flow-canvas project use <id-or-url>', EXIT_CODES.VALIDATION);
  }
  const state = loadState();
  const raw = String(target).trim();
  let targetUrl = null;
  let known = null;

  if (/^https?:\/\//i.test(raw)) {
    targetUrl = raw;
  } else if (state.projects[raw]) {
    known = state.projects[raw];
    targetUrl = known.webUrl;
  } else {
    const byTitle = Object.values(state.projects).find(
      (p) => p.title && p.title.toLowerCase().includes(raw.toLowerCase())
    );
    if (byTitle) {
      known = byTitle;
      targetUrl = byTitle.webUrl;
    } else {
      targetUrl = `https://flow.google.com/project/${encodeURIComponent(raw)}`;
    }
  }

  return withFlowPage({ targetUrl, bringToFront: true }, async ({ page }) => {
    await page.waitForTimeout(1000);
    const status = await detectAuthAndPageState(page);
    if (status.needsLogin) {
      throw new CliError(
        `Google sign-in required in Chrome (${status.url}).`,
        EXIT_CODES.LOGIN_REQUIRED,
        status
      );
    }

    const projectId = extractProjectIdFromUrl(status.url) || (known && known.projectId) || raw;
    const nextState = setCurrentProject({
      projectId,
      title: (known && known.title) || status.headingText || status.title || projectId,
      webUrl: status.url,
    });

    return {
      selected: true,
      project: nextState.currentProject,
      inProject: status.inProject,
      hasPromptComposer: status.hasPromptComposer,
    };
  });
}

async function cmdProjectCurrent() {
  const state = loadState();
  return withFlowPage({}, async ({ page }) => {
    const status = await detectAuthAndPageState(page);
    if (status.projectId) {
      setCurrentProject({
        projectId: status.projectId,
        title: status.headingText || status.title,
        webUrl: status.url,
      });
    }
    const updated = loadState();
    return {
      currentProject: updated.currentProject || state.currentProject,
      livePage: status,
      recentDrafts: updated.stagedDrafts.slice(0, 5),
    };
  });
}

async function cmdProjectInspect() {
  return withFlowPage({ requireProject: true }, async ({ page }) => {
    return inspectPageDom(page);
  });
}

async function cmdAssetList({ category = 'semua', query = '' } = {}) {
  const canon = normalizeCategoryKey(category);
  return withFlowPage({ requireProject: true }, async ({ page }) => {
    const auth = await detectAuthAndPageState(page);
    if (auth.needsLogin) {
      throw new CliError('Google sign-in required in Chrome.', EXIT_CODES.LOGIN_REQUIRED, auth);
    }

    const tabRes = await openAssetTab(page, canon);
    if (query) {
      await searchAssetsInDrawer(page, query);
    }
    const items = await readVisibleAssets(page);
    return {
      category: canon,
      tabClicked: tabRes.matched,
      query: query || null,
      count: items.length,
      items,
      webUrl: page.url(),
    };
  });
}

async function cmdAssetUpload({ files = [], category = 'uploaded' } = {}) {
  if (!files || files.length === 0) {
    throw new CliError(
      'Missing file path(s). Usage: flow-canvas asset upload <file...> [--category uploaded|karakter|avatar]',
      EXIT_CODES.VALIDATION
    );
  }
  const canon = normalizeCategoryKey(category);
  return withFlowPage({ bringToFront: true, requireProject: true }, async ({ page }) => {
    const auth = await detectAuthAndPageState(page);
    if (auth.needsLogin) {
      throw new CliError('Google sign-in required in Chrome.', EXIT_CODES.LOGIN_REQUIRED, auth);
    }

    const res = await uploadFilesInUi(page, files, canon);
    return {
      category: canon,
      ...res,
      fileNames: res.uploaded.map((f) => path.basename(f)),
      webUrl: page.url(),
    };
  });
}

async function cmdAssetAttach({ query, category = 'semua' } = {}) {
  if (!query) {
    throw new CliError('Missing asset query/name. Usage: flow-canvas asset attach <name>', EXIT_CODES.VALIDATION);
  }
  const canon = normalizeCategoryKey(category);
  return withFlowPage({ bringToFront: true, requireProject: true }, async ({ page }) => {
    const auth = await detectAuthAndPageState(page);
    if (auth.needsLogin) {
      throw new CliError('Google sign-in required in Chrome.', EXIT_CODES.LOGIN_REQUIRED, auth);
    }

    const res = await attachAssetInUi(page, query, canon);
    return {
      category: canon,
      query,
      ...res,
      webUrl: page.url(),
    };
  });
}

async function cmdVoiceList({ query = '', live = false } = {}) {
  const catalogMatches = findVoices(query);
  if (!live) {
    return {
      source: 'catalog',
      maxDialogLength: MAX_DIALOG_LENGTH,
      count: catalogMatches.length,
      voices: catalogMatches,
    };
  }

  return withFlowPage({}, async ({ page }) => {
    const auth = await detectAuthAndPageState(page);
    if (auth.needsLogin) {
      throw new CliError('Google sign-in required in Chrome.', EXIT_CODES.LOGIN_REQUIRED, auth);
    }

    await openAssetTab(page, 'suara');
    if (query) {
      await searchAssetsInDrawer(page, query);
    }
    const items = await readVisibleAssets(page);
    return {
      source: 'live-and-catalog',
      maxDialogLength: MAX_DIALOG_LENGTH,
      liveItems: items,
      catalogVoices: catalogMatches,
      webUrl: page.url(),
    };
  });
}

async function cmdVoiceAdd({ name, dialog = '', style = '', saveName = '', preview = false } = {}) {
  if (!name) {
    throw new CliError(
      'Missing voice name. Usage: flow-canvas voice add --name Achernar [--dialog "..."] [--style "..."]',
      EXIT_CODES.VALIDATION
    );
  }
  const catalogMatch = resolveVoiceExact(name);
  const voiceName = catalogMatch ? catalogMatch.name : name;

  return withFlowPage({ bringToFront: true, requireProject: true }, async ({ page }) => {
    const auth = await detectAuthAndPageState(page);
    if (auth.needsLogin) {
      throw new CliError('Google sign-in required in Chrome.', EXIT_CODES.LOGIN_REQUIRED, auth);
    }

    const res = await configureVoiceInUi(page, {
      voiceName,
      dialog,
      style,
      saveName,
      preview,
    });

    return {
      catalogVoice: catalogMatch,
      ...res,
      webUrl: page.url(),
    };
  });
}

async function cmdVoicePreview({ name, dialog = '', style = '', saveName = '' } = {}) {
  if (!name) {
    throw new CliError(
      'Missing voice name. Usage: flow-canvas voice preview --name Achernar [--dialog "..."] [--style "..."]',
      EXIT_CODES.VALIDATION
    );
  }
  const catalogMatch = resolveVoiceExact(name);
  const voiceName = catalogMatch ? catalogMatch.name : name;

  return withFlowPage({ bringToFront: true, requireProject: true }, async ({ page }) => {
    const auth = await detectAuthAndPageState(page);
    if (auth.needsLogin) {
      throw new CliError('Google sign-in required in Chrome.', EXIT_CODES.LOGIN_REQUIRED, auth);
    }

    const res = await configureVoiceInUi(page, {
      voiceName,
      dialog,
      style,
      saveName,
      preview: true,
    });
    return {
      catalogVoice: catalogMatch,
      ...res,
      webUrl: page.url(),
    };
  });
}

async function stageSingleQueueItemOnPage(page, auth, item) {
  const startedAt = Date.now();
  const uploads = Array.isArray(item.uploads) ? item.uploads : [];
  const assets = Array.isArray(item.assets) ? item.assets : [];

  if (item.clear) {
    await clearPromptInUi(page);
  }

  if (item.mode) {
    await selectComposerModeInUi(page, item.mode).catch(() => {});
  }

  const uploadResults = [];
  if (uploads.length > 0) {
    const up = await uploadFilesInUi(page, uploads, 'uploaded', { attachUploaded: true, skipExisting: true });
    uploadResults.push(up);
  }

  const attachResults = [];
  for (const assetQuery of assets) {
    const att = await attachAssetInUi(page, assetQuery, 'semua');
    attachResults.push(att);
  }

  let voiceResult = null;
  if (item.voice) {
    const catalogMatch = resolveVoiceExact(item.voice);
    voiceResult = await configureVoiceInUi(page, {
      voiceName: catalogMatch ? catalogMatch.name : item.voice,
      dialog: item.voiceDialog || '',
      style: item.voiceStyle || '',
      saveName: item.voiceSaveName || '',
      preview: false,
    });
  }

  const stageResult = await stagePromptInUi(page, {
    prompt: item.prompt,
    clear: false,
    mode: null,
  });
  stageResult.clearedPrevious = Boolean(item.clear);
  await page.waitForTimeout(80);
  const composerState = await readComposerState(page);

  const projectId = extractProjectIdFromUrl(page.url()) || 'active';
  const draftRecord = recordStagedDraft({
    projectId,
    webUrl: page.url(),
    title: item.title || null,
    mode: item.mode || null,
    prompt: String(item.prompt),
    uploads: uploads.map((f) => path.resolve(f)),
    assets,
    voice: item.voice || null,
  });

  if (extractProjectIdFromUrl(page.url())) {
    setCurrentProject({
      projectId,
      title: item.title || (auth && (auth.headingText || auth.title)) || projectId,
      webUrl: page.url(),
    });
  }

  return {
    staged: true,
    elapsedMs: Date.now() - startedAt,
    manualGenerateRequired: true,
    generateClicked: false,
    draftId: draftRecord.id,
    title: item.title || null,
    projectId,
    webUrl: page.url(),
    uploads: uploadResults,
    attachedAssets: attachResults,
    voice: voiceResult,
    composer: stageResult,
    composerState,
    handoffMessage: composerState.generateReady
      ? 'Prompt and uploaded materials are staged and generate-ready in Google Flow. Click Generate in the browser when ready.'
      : 'Prompt and materials are staged in Google Flow; check composerState for any remaining requirements before clicking Generate.',
  };
}

async function cmdPromptStage({
  prompt,
  title = '',
  uploads = [],
  assets = [],
  voice = '',
  voiceDialog = '',
  voiceStyle = '',
  voiceSaveName = '',
  mode = '',
  clear = false,
} = {}) {
  if (!prompt || !String(prompt).trim()) {
    throw new CliError(
      'Missing prompt text. Usage: flow-canvas prompt stage "Your prompt..." [--upload file.png] [--voice Achernar]',
      EXIT_CODES.VALIDATION
    );
  }

  return withFlowPage({ bringToFront: true, requireProject: true }, async ({ page }) => {
    const auth = await detectAuthAndPageState(page);
    if (auth.needsLogin) {
      throw new CliError('Google sign-in required in Chrome.', EXIT_CODES.LOGIN_REQUIRED, auth);
    }

    return stageSingleQueueItemOnPage(page, auth, {
      prompt,
      title,
      uploads,
      assets,
      voice,
      voiceDialog,
      voiceStyle,
      voiceSaveName,
      mode,
      clear,
    });
  });
}

function resolveExistingPaths(paths = [], missingPrefix = 'Queued upload file not found') {
  return (paths || []).map((f) => {
    const abs = path.resolve(f);
    if (!fs.existsSync(abs)) {
      throw new CliError(`${missingPrefix}: ${abs}`, EXIT_CODES.VALIDATION);
    }
    return abs;
  });
}

async function stageQueueItemInBrowser(item, { clear = true } = {}) {
  return withFlowPage({ bringToFront: true, requireProject: true }, async ({ page }) => {
    const auth = await detectAuthAndPageState(page);
    if (auth.needsLogin) {
      throw new CliError('Google sign-in required in Chrome.', EXIT_CODES.LOGIN_REQUIRED, auth);
    }
    return stageSingleQueueItemOnPage(page, auth, { ...item, clear });
  });
}

async function cmdQueueAdd({
  prompt,
  title = '',
  uploads = [],
  assets = [],
  voice = '',
  voiceDialog = '',
  voiceStyle = '',
  voiceSaveName = '',
  mode = '',
  preupload = false,
} = {}) {
  if (!prompt || !String(prompt).trim()) {
    throw new CliError(
      'Missing prompt text. Usage: flow-canvas queue add "Your prompt..." [--upload file.png] [--preupload]',
      EXIT_CODES.VALIDATION
    );
  }

  const resolvedUploads = resolveExistingPaths(uploads);

  const enqueued = enqueuePromptItems([
    {
      prompt: String(prompt),
      title: title || null,
      uploads: resolvedUploads,
      assets: assets || [],
      voice,
      voiceDialog,
      voiceStyle,
      voiceSaveName,
      mode,
    },
  ]);

  let preuploadResult = null;
  let composerStateAfter = null;
  if (preupload && resolvedUploads.length > 0) {
    await withFlowPage({ requireProject: true }, async ({ page }) => {
      const auth = await detectAuthAndPageState(page);
      if (auth.needsLogin) {
        throw new CliError('Google sign-in required in Chrome.', EXIT_CODES.LOGIN_REQUIRED, auth);
      }
      preuploadResult = await uploadFilesInUi(page, resolvedUploads, 'uploaded', {
        attachUploaded: false,
        skipExisting: true,
      });
      await closeAssetDrawerIfOpen(page);
      composerStateAfter = await readComposerState(page);
    });
  }

  return {
    queued: true,
    added: enqueued.added,
    summary: enqueued.summary,
    preupload: preuploadResult
      ? {
          method: preuploadResult.method,
          newlyUploaded: preuploadResult.newlyUploaded,
          skippedExisting: preuploadResult.skippedExisting,
          composerPreserved: composerStateAfter ? Boolean(composerStateAfter.promptText || composerStateAfter.ingredientChips.length) : null,
          composerState: composerStateAfter,
        }
      : null,
  };
}

function cmdQueueList() {
  return getPromptQueue();
}

function cmdQueueClear({ completedOnly = false } = {}) {
  return clearPromptQueue({ completedOnly });
}

async function cmdQueueNext() {
  const qBefore = getPromptQueue();
  const stagedItems = qBefore.items.filter((q) => q.status === 'staged');
  for (const item of stagedItems) {
    updateQueueItem(item.id, { status: 'submitted', submittedAt: new Date().toISOString() });
  }

  const nextItem = getPromptQueue().items.find((q) => q.status === 'pending');
  if (!nextItem) {
    const finalQueue = getPromptQueue();
    return {
      advanced: false,
      message: 'No pending items left in queue.',
      summary: finalQueue.summary,
    };
  }

  const stagedResult = await stageQueueItemInBrowser(nextItem, { clear: true });

  updateQueueItem(nextItem.id, { status: 'staged', stagedAt: new Date().toISOString() });
  const qAfter = getPromptQueue();
  return {
    advanced: true,
    queueItemId: nextItem.id,
    staged: stagedResult,
    summary: qAfter.summary,
  };
}

async function cmdQueueEdit({
  target = 'current',
  prompt,
  title,
  uploads,
  addUploads,
  assets,
  voice,
  voiceDialog,
  voiceStyle,
  voiceSaveName,
  mode,
  preupload = false,
  restage,
} = {}) {
  const existing = findQueueItem(target);
  if (!existing) {
    throw new CliError(`Queue item not found for target: ${target}`, EXIT_CODES.VALIDATION);
  }

  const patch = {};
  if (prompt !== undefined && String(prompt).trim() !== '') {
    patch.prompt = String(prompt);
  }
  if (title !== undefined && String(title).trim() !== '') {
    patch.title = String(title);
  }

  const hasReplaceUploads = Array.isArray(uploads) && uploads.length > 0;
  const hasAddUploads = Array.isArray(addUploads) && addUploads.length > 0;
  if (hasReplaceUploads || hasAddUploads) {
    let nextUploads = hasReplaceUploads
      ? resolveExistingPaths(uploads)
      : Array.isArray(existing.uploads)
        ? [...existing.uploads]
        : [];
    if (hasAddUploads) {
      for (const p of resolveExistingPaths(addUploads)) {
        if (!nextUploads.includes(p)) {
          nextUploads.push(p);
        }
      }
    }
    patch.uploads = nextUploads;
  }

  if (Array.isArray(assets) && assets.length > 0) {
    patch.assets = assets;
  }
  for (const [key, val] of [
    ['voice', voice],
    ['voiceDialog', voiceDialog],
    ['voiceStyle', voiceStyle],
    ['voiceSaveName', voiceSaveName],
    ['mode', mode],
  ]) {
    if (val !== undefined && String(val) !== '') {
      patch[key] = String(val);
    }
  }

  const updated = updateQueueItem(existing.id, patch);
  const shouldRestage = restage !== undefined ? Boolean(restage) : updated.status === 'staged';

  let stagedResult = null;
  let preuploadResult = null;
  if (shouldRestage) {
    stagedResult = await stageQueueItemInBrowser(updated, { clear: true });
    updateQueueItem(updated.id, { status: 'staged', stagedAt: new Date().toISOString() });
  } else if (preupload && Array.isArray(updated.uploads) && updated.uploads.length > 0) {
    await withFlowPage({ requireProject: true }, async ({ page }) => {
      const auth = await detectAuthAndPageState(page);
      if (auth.needsLogin) {
        throw new CliError('Google sign-in required in Chrome.', EXIT_CODES.LOGIN_REQUIRED, auth);
      }
      preuploadResult = await uploadFilesInUi(page, updated.uploads, 'uploaded', {
        attachUploaded: false,
        skipExisting: true,
      });
      await closeAssetDrawerIfOpen(page);
    });
  }

  const finalQueue = getPromptQueue();
  return {
    updated: finalQueue.items.find((q) => q.id === updated.id) || updated,
    restaged: Boolean(shouldRestage),
    stagedResult,
    preuploadResult,
    summary: finalQueue.summary,
  };
}

async function cmdQueueRetry({ target = 'current' } = {}) {
  const item = findQueueItem(target);
  if (!item) {
    throw new CliError('No staged or matching queue item found to retry.', EXIT_CODES.VALIDATION);
  }

  const stagedResult = await stageQueueItemInBrowser(item, { clear: true });
  updateQueueItem(item.id, { status: 'staged', stagedAt: new Date().toISOString() });
  return {
    retried: true,
    queueItemId: item.id,
    staged: stagedResult,
    summary: getPromptQueue().summary,
  };
}

async function cmdQueueWatch({ pollMs = 450, timeoutMinutes = 30, preuploadAll = true } = {}) {
  const initialQueue = getPromptQueue();
  if (initialQueue.summary.pending === 0 && initialQueue.summary.staged === 0) {
    return {
      watched: false,
      message: 'Queue is empty. Use `flow-canvas queue add` first.',
      summary: initialQueue.summary,
    };
  }

  const intervalMs = Math.max(150, Number(pollMs) || 450);
  const deadline = Date.now() + Math.max(1, Number(timeoutMinutes) || 30) * 60 * 1000;

  return withFlowPage({ bringToFront: true, requireProject: true }, async ({ page }) => {
    const auth = await detectAuthAndPageState(page);
    if (auth.needsLogin) {
      throw new CliError('Google sign-in required in Chrome.', EXIT_CODES.LOGIN_REQUIRED, auth);
    }

    const pendingItems = getPromptQueue().items.filter((q) => q.status === 'pending');
    const uniqueFiles = Array.from(
      new Set(
        pendingItems.flatMap((q) => (Array.isArray(q.uploads) ? q.uploads : [])).map((f) => path.resolve(f))
      )
    );

    let batchPreupload = null;
    if (preuploadAll && uniqueFiles.length > 0) {
      batchPreupload = await uploadFilesInUi(page, uniqueFiles, 'uploaded', {
        attachUploaded: false,
        skipExisting: true,
      });
      await closeAssetDrawerIfOpen(page);
    }

    const transitions = [];
    const currentComposer = await readComposerState(page);
    const hasLivePrompt = Boolean(currentComposer.promptText || currentComposer.ingredientChips.length > 0);
    const currentStaged = getPromptQueue().items.filter((q) => q.status === 'staged');

    // If composer is currently empty, mark any old staged items submitted and stage the first pending item
    if (!hasLivePrompt) {
      for (const oldStaged of currentStaged) {
        updateQueueItem(oldStaged.id, { status: 'submitted', submittedAt: new Date().toISOString() });
      }
      const firstPending = getPromptQueue().items.find((q) => q.status === 'pending');
      if (firstPending) {
        const res = await stageSingleQueueItemOnPage(page, auth, { ...firstPending, clear: true });
        updateQueueItem(firstPending.id, { status: 'staged', stagedAt: new Date().toISOString() });
        transitions.push({ action: 'initial-stage', id: firstPending.id, title: firstPending.title, elapsedMs: res.elapsedMs });
        process.stderr.write(`[flow-queue] Staged "${firstPending.title || firstPending.id}" (${res.elapsedMs}ms). Waiting for Generate click...\n`);
      }
    }

    // If no pending items remain, exit immediately with the final item ready in the composer
    if (getPromptQueue().summary.pending === 0) {
      const doneQueue = getPromptQueue();
      return {
        watched: true,
        allPendingStaged: true,
        timedOut: false,
        preuploadedCount: batchPreupload ? batchPreupload.newlyUploaded.length : 0,
        transitions,
        summary: doneQueue.summary,
        composerState: await readComposerState(page),
      };
    }

    let timedOut = false;
    while (getPromptQueue().summary.pending > 0) {
      if (Date.now() >= deadline) {
        timedOut = true;
        break;
      }

      const live = await readComposerState(page);
      if (!live.promptText && live.ingredientChips.length === 0) {
        // Confirm after 300ms to avoid reacting to transient DOM updates
        await page.waitForTimeout(300);
        const confirmed = await readComposerState(page);
        if (!confirmed.promptText && confirmed.ingredientChips.length === 0) {
          for (const st of getPromptQueue().items.filter((q) => q.status === 'staged')) {
            updateQueueItem(st.id, { status: 'submitted', submittedAt: new Date().toISOString() });
          }
          await page.waitForTimeout(250);

          const nextItem = getPromptQueue().items.find((q) => q.status === 'pending');
          if (!nextItem) break;

          const res = await stageSingleQueueItemOnPage(page, auth, { ...nextItem, clear: true });
          updateQueueItem(nextItem.id, { status: 'staged', stagedAt: new Date().toISOString() });
          transitions.push({
            action: 'auto-refill',
            id: nextItem.id,
            title: nextItem.title,
            elapsedMs: res.elapsedMs,
            generateReady: res.composerState.generateReady,
          });
          process.stderr.write(
            `[flow-queue] Refilled "${nextItem.title || nextItem.id}" in ${res.elapsedMs}ms (remaining pending: ${getPromptQueue().summary.pending})\n`
          );

          if (getPromptQueue().summary.pending === 0) {
            break;
          }
        }
      }

      await page.waitForTimeout(intervalMs);
    }

    const finalQueue = getPromptQueue();
    return {
      watched: true,
      allPendingStaged: finalQueue.summary.pending === 0,
      timedOut,
      preuploadedCount: batchPreupload ? batchPreupload.newlyUploaded.length : 0,
      transitions,
      summary: finalQueue.summary,
      composerState: await readComposerState(page),
    };
  });
}

function getSupportedCategories() {
  return Object.keys(ASSET_CATEGORIES);
}

module.exports = {
  EXIT_CODES,
  CliError,
  SCHEMA_DEFINITION,
  checkManualGuardrail,
  cmdVersion,
  cmdSchema,
  cmdAuthStatus,
  cmdProjectList,
  cmdProjectCreate,
  cmdProjectUse,
  cmdProjectCurrent,
  cmdProjectInspect,
  cmdAssetList,
  cmdAssetUpload,
  cmdAssetAttach,
  cmdVoiceList,
  cmdVoiceAdd,
  cmdVoicePreview,
  cmdPromptStage,
  cmdQueueAdd,
  cmdQueueList,
  cmdQueueClear,
  cmdQueueNext,
  cmdQueueEdit,
  cmdQueueRetry,
  cmdQueueWatch,
  getSupportedCategories,
  loadState,
  saveState,
};
