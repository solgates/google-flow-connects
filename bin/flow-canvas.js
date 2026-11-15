#!/usr/bin/env node
'use strict';

const {
  EXIT_CODES,
  CliError,
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
} = require('../src/commands');
const { startMcpServer } = require('../src/mcp-server');

const REPEATABLE_FLAGS = new Set(['upload', 'add-upload', 'asset', 'ref', 'file']);
const BOOLEAN_FLAGS = new Set([
  'help',
  'h',
  'json',
  'clear',
  'preview',
  'live',
  'run',
  'submit',
  'no-interactive',
  'preupload',
  'no-preupload',
  'completed',
  'enqueue',
  'restage',
  'no-restage',
  'current',
]);

function parseArgs(argv) {
  const positionals = [];
  const flags = {
    upload: [],
    asset: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }

    if (token === '-h') {
      flags.help = true;
      continue;
    }
    if (token === '-o') {
      flags.outputFormat = argv[++i] || 'json';
      continue;
    }
    if (token === '-q') {
      flags.query = argv[++i] || '';
      continue;
    }

    if (token.startsWith('--')) {
      const eqIdx = token.indexOf('=');
      const rawKey = eqIdx !== -1 ? token.slice(2, eqIdx) : token.slice(2);
      const camelKey = rawKey.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());

      if (eqIdx !== -1) {
        const val = token.slice(eqIdx + 1);
        if (REPEATABLE_FLAGS.has(rawKey)) {
          flags[camelKey] = flags[camelKey] || [];
          flags[camelKey].push(val);
        } else if (val === 'true' || val === 'false') {
          flags[camelKey] = val === 'true';
        } else {
          flags[camelKey] = val;
        }
        continue;
      }

      if (BOOLEAN_FLAGS.has(rawKey)) {
        flags[camelKey] = true;
        continue;
      }

      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        i++;
        if (REPEATABLE_FLAGS.has(rawKey)) {
          flags[camelKey] = flags[camelKey] || [];
          flags[camelKey].push(next);
        } else {
          flags[camelKey] = next;
        }
      } else {
        flags[camelKey] = true;
      }
      continue;
    }

    positionals.push(token);
  }

  return { positionals, flags };
}

function isJsonOutput(flags) {
  return Boolean(flags.json || String(flags.outputFormat || '').toLowerCase() === 'json');
}

function printResult(command, data, flags) {
  if (isJsonOutput(flags) || command === 'schema') {
    process.stdout.write(JSON.stringify({ schemaVersion: '2', ok: true, command, data }, null, 2) + '\n');
    return;
  }

  if (command === 'version') {
    console.log(`flow-canvas v${data.version} (Node ${data.node})`);
    console.log(`CDP: ${data.cdpUrl} (${data.cdpRunning ? 'running' : 'stopped'})`);
    if (data.currentProject) {
      console.log(`Active project: ${data.currentProject.title} [${data.currentProject.projectId}] -> ${data.currentProject.webUrl}`);
    }
    return;
  }

  if (command === 'voice list' && Array.isArray(data.voices)) {
    console.log(`Google Flow Voices (${data.voices.length}, dialog limit: ${data.maxDialogLength} chars):`);
    for (const v of data.voices) {
      const badge = v.uiVerified ? '*' : ' ';
      console.log(`  ${badge} ${v.name.padEnd(15)} ${v.gender.padEnd(7)} ${v.style}`);
    }
    return;
  }

  if (command === 'project ls' && Array.isArray(data.projects)) {
    console.log(`Current URL: ${data.activeUrl}`);
    if (data.currentProject) {
      console.log(`Current Project: ${data.currentProject.title} (${data.currentProject.projectId})`);
    }
    console.log(`Projects (${data.projects.length}):`);
    for (const p of data.projects) {
      console.log(`  - ${p.projectId} | ${p.title} | ${p.webUrl}`);
    }
    return;
  }

  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

function printHelp() {
  console.log(`flow-canvas (google-flow) — Dreamina-style CLI & MCP bridge for Google Flow

Usage:
  flow-canvas <command> [subcommand] [args] [flags]

Commands:
  version                                      Show CLI version and CDP connection state
  schema [command]                             Print JSON schema ("schemaVersion": "2")
  auth status | login                          Ensure Chrome CDP is running & check Flow login
  project ls | create | use <id|url> | current | inspect
                                               Manage Google Flow projects (alias: canvas)
  asset ls | upload <files...> | attach <name> Manage project assets (alias: resource)
  voice list | add | preview                   Configure "Suara" voices + Contoh dialog + style
  prompt stage [text]                          Stage uploads, assets, voice & prompt (NO Generate)
  queue add | ls | next | edit | retry | watch | clear
                                               Persistent shot queue with step-by-step review/revise or auto-refill
  mcp                                          Start stdio MCP server for Antigravity & Kiro

Dreamina-compatible aliases:
  canvas ls | create | use | current           -> project ...
  resource ls | upload | attach                -> asset ...
  node create | edit                           -> prompt stage ...

Global flags:
  -o json | --json                             Emit structured JSON envelope
  -h | --help                                  Show this help message

Manual-Only Guardrail:
  --run, --submit, node run, and prompt submit are blocked (exit 13).
  The CLI stages everything in the active Flow browser tab; you click Generate.`);
}

async function dispatchQueueCommand(qSub, promptArgsStart, positionals, flags) {
  if (qSub === 'add') {
    return {
      cmdLabel: 'queue add',
      result: await cmdQueueAdd({
        prompt: flags.prompt || positionals.slice(promptArgsStart).join(' '),
        title: flags.title || '',
        uploads: [...(flags.upload || []), ...(flags.file || [])],
        assets: [...(flags.asset || []), ...(flags.ref || [])],
        voice: flags.voice || flags.voiceName || '',
        voiceDialog: flags.voiceDialog || flags.dialog || '',
        voiceStyle: flags.voiceStyle || flags.style || '',
        voiceSaveName: flags.voiceSaveName || flags.saveName || '',
        mode: flags.mode || '',
        preupload: Boolean(flags.preupload),
      }),
    };
  }
  if (qSub === 'ls' || qSub === 'list' || qSub === 'status') {
    return { cmdLabel: 'queue ls', result: cmdQueueList() };
  }
  if (qSub === 'next') {
    return { cmdLabel: 'queue next', result: await cmdQueueNext() };
  }
  if (qSub === 'edit' || qSub === 'update') {
    const target = flags.current ? 'current' : (flags.id || flags.target || positionals[promptArgsStart] || 'current');
    const uploads = [...(flags.upload || []), ...(flags.file || [])];
    const assets = [...(flags.asset || []), ...(flags.ref || [])];
    return {
      cmdLabel: 'queue edit',
      result: await cmdQueueEdit({
        target,
        prompt: flags.prompt,
        title: flags.title,
        uploads: uploads.length > 0 ? uploads : undefined,
        addUploads: flags.addUpload && flags.addUpload.length > 0 ? flags.addUpload : undefined,
        assets: assets.length > 0 ? assets : undefined,
        voice: flags.voice !== undefined ? flags.voice : flags.voiceName,
        voiceDialog: flags.voiceDialog !== undefined ? flags.voiceDialog : flags.dialog,
        voiceStyle: flags.voiceStyle !== undefined ? flags.voiceStyle : flags.style,
        voiceSaveName: flags.voiceSaveName !== undefined ? flags.voiceSaveName : flags.saveName,
        mode: flags.mode,
        preupload: Boolean(flags.preupload),
        restage: flags.noRestage ? false : (flags.restage ? true : undefined),
      }),
    };
  }
  if (qSub === 'retry' || qSub === 'restage') {
    const target = flags.id || flags.target || positionals[promptArgsStart] || 'current';
    return {
      cmdLabel: 'queue retry',
      result: await cmdQueueRetry({ target }),
    };
  }
  if (qSub === 'watch' || qSub === 'start') {
    return {
      cmdLabel: 'queue watch',
      result: await cmdQueueWatch({
        pollMs: flags.pollMs,
        timeoutMinutes: flags.timeout,
        preuploadAll: !flags.noPreupload,
      }),
    };
  }
  if (qSub === 'clear') {
    return { cmdLabel: 'queue clear', result: cmdQueueClear({ completedOnly: Boolean(flags.completed) }) };
  }
  throw new CliError(`Unknown queue subcommand: ${qSub}`, EXIT_CODES.VALIDATION);
}

async function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const rawC0 = (positionals[0] || '').toLowerCase();
  const rawC1 = (positionals[1] || '').toLowerCase();

  if (flags.help || positionals.length === 0 || rawC0 === 'help') {
    printHelp();
    process.exit(EXIT_CODES.OK);
  }

  if (rawC0 === 'mcp') {
    await startMcpServer();
    return;
  }

  if (rawC0 === 'schema') {
    const target = positionals.slice(1).join(' ').trim();
    const data = cmdSchema(target || null);
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    process.exit(EXIT_CODES.OK);
  }

  checkManualGuardrail(flags, positionals);

  const c0 = rawC0 === 'canvas' ? 'project' : rawC0 === 'resource' ? 'asset' : rawC0;
  let result;
  let cmdLabel = `${c0}${rawC1 ? ' ' + rawC1 : ''}`;

  if (c0 === 'version') {
    result = await cmdVersion();
  } else if (c0 === 'auth') {
    if (rawC1 === 'status' || rawC1 === 'login' || !rawC1) {
      cmdLabel = `auth ${rawC1 || 'status'}`;
      result = await cmdAuthStatus({ bringToFront: rawC1 === 'login' });
    } else {
      throw new CliError(`Unknown auth subcommand: ${rawC1}`, EXIT_CODES.VALIDATION);
    }
  } else if (c0 === 'project') {
    if (rawC1 === 'ls' || rawC1 === 'list' || !rawC1) {
      cmdLabel = 'project ls';
      result = await cmdProjectList();
    } else if (rawC1 === 'create' || rawC1 === 'new') {
      cmdLabel = 'project create';
      result = await cmdProjectCreate({ title: flags.title || positionals[2] || '' });
    } else if (rawC1 === 'use' || rawC1 === 'open') {
      cmdLabel = 'project use';
      result = await cmdProjectUse(positionals[2] || flags.id || flags.project);
    } else if (rawC1 === 'current') {
      cmdLabel = 'project current';
      result = await cmdProjectCurrent();
    } else if (rawC1 === 'inspect') {
      cmdLabel = 'project inspect';
      result = await cmdProjectInspect();
    } else {
      throw new CliError(`Unknown project subcommand: ${rawC1}`, EXIT_CODES.VALIDATION);
    }
  } else if (c0 === 'asset') {
    if (rawC1 === 'ls' || rawC1 === 'list' || !rawC1) {
      cmdLabel = 'asset ls';
      result = await cmdAssetList({ category: flags.category || 'semua', query: flags.query || '' });
    } else if (rawC1 === 'upload') {
      cmdLabel = 'asset upload';
      const files = [...positionals.slice(2), ...(flags.file || [])];
      result = await cmdAssetUpload({ files, category: flags.category || 'uploaded' });
    } else if (rawC1 === 'attach') {
      cmdLabel = 'asset attach';
      result = await cmdAssetAttach({
        query: positionals.slice(2).join(' ') || flags.query || '',
        category: flags.category || 'semua',
      });
    } else {
      throw new CliError(`Unknown asset subcommand: ${rawC1}`, EXIT_CODES.VALIDATION);
    }
  } else if (c0 === 'voice') {
    if (rawC1 === 'list' || rawC1 === 'ls' || !rawC1) {
      cmdLabel = 'voice list';
      result = await cmdVoiceList({ query: flags.query || positionals[2] || '', live: Boolean(flags.live) });
    } else if (rawC1 === 'add') {
      cmdLabel = 'voice add';
      result = await cmdVoiceAdd({
        name: flags.name || flags.voiceName || positionals[2] || '',
        dialog: flags.dialog || flags.voiceDialog || '',
        style: flags.style || flags.voiceStyle || '',
        saveName: flags.voiceSaveName || flags.saveName || '',
        preview: Boolean(flags.preview),
      });
    } else if (rawC1 === 'preview') {
      cmdLabel = 'voice preview';
      result = await cmdVoicePreview({
        name: flags.name || flags.voiceName || positionals[2] || '',
        dialog: flags.dialog || flags.voiceDialog || '',
        style: flags.style || flags.voiceStyle || '',
        saveName: flags.voiceSaveName || flags.saveName || '',
      });
    } else {
      throw new CliError(`Unknown voice subcommand: ${rawC1}`, EXIT_CODES.VALIDATION);
    }
  } else if (c0 === 'prompt' || c0 === 'node') {
    if (c0 === 'prompt' && rawC1 === 'queue') {
      ({ cmdLabel, result } = await dispatchQueueCommand((positionals[2] || 'ls').toLowerCase(), 3, positionals, flags));
    } else if (rawC1 === 'stage' || rawC1 === 'create' || rawC1 === 'edit' || !rawC1) {
      cmdLabel = flags.enqueue ? 'queue add' : 'prompt stage';
      const rest = positionals.slice(2);
      let inferredMode = flags.mode || '';
      let promptPositional = rest.join(' ');
      if (c0 === 'node' && rest[0] && /^(image|video|gambar|audio|suara)$/i.test(rest[0])) {
        inferredMode = inferredMode || rest[0];
        promptPositional = rest.slice(1).join(' ');
      }
      const promptText = flags.prompt || promptPositional;
      const uploads = [...(flags.upload || []), ...(flags.file || [])];
      const assets = [...(flags.asset || []), ...(flags.ref || [])];

      if (flags.enqueue) {
        result = await cmdQueueAdd({
          prompt: promptText,
          title: flags.title || '',
          uploads,
          assets,
          voice: flags.voice || flags.voiceName || '',
          voiceDialog: flags.voiceDialog || flags.dialog || '',
          voiceStyle: flags.voiceStyle || flags.style || '',
          voiceSaveName: flags.voiceSaveName || flags.saveName || '',
          mode: inferredMode,
          preupload: Boolean(flags.preupload),
        });
      } else {
        result = await cmdPromptStage({
          prompt: promptText,
          title: flags.title || '',
          uploads,
          assets,
          voice: flags.voice || flags.voiceName || '',
          voiceDialog: flags.voiceDialog || flags.dialog || '',
          voiceStyle: flags.voiceStyle || flags.style || '',
          voiceSaveName: flags.voiceSaveName || flags.saveName || '',
          mode: inferredMode,
          clear: Boolean(flags.clear),
        });
      }
    } else {
      throw new CliError(`Unknown ${c0} subcommand: ${rawC1}`, EXIT_CODES.VALIDATION);
    }
  } else if (c0 === 'queue') {
    ({ cmdLabel, result } = await dispatchQueueCommand(rawC1 || 'ls', 2, positionals, flags));
  } else {
    throw new CliError(`Unknown command: ${positionals.join(' ')}. Run \`flow-canvas --help\`.`, EXIT_CODES.VALIDATION);
  }

  printResult(cmdLabel, result, flags);
  process.exit(EXIT_CODES.OK);
}

main().catch((err) => {
  const exitCode = err instanceof CliError ? err.exitCode : EXIT_CODES.ERROR;
  const payload = {
    schemaVersion: '2',
    ok: false,
    error: {
      code: exitCode,
      message: err.message || String(err),
      details: err.details || undefined,
    },
  };
  process.stderr.write(JSON.stringify(payload, null, 2) + '\n');
  process.exit(exitCode);
});
