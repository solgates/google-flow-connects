'use strict';

const {
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
  cmdPromptStage,
  cmdQueueAdd,
  cmdQueueList,
  cmdQueueClear,
  cmdQueueNext,
  cmdQueueEdit,
  cmdQueueRetry,
} = require('./commands');
const pkg = require('../package.json');

const TOOLS = [
  {
    name: 'flow_project_list',
    description: 'Check Google Flow auth state and list discovered Google Flow projects from the active browser tab and local state.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'flow_project_create',
    description: 'Create a new Google Flow project in the active Chrome CDP session and return its projectId and webUrl.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Optional title for the new Flow project.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'flow_project_use',
    description: 'Navigate the active Google Flow Chrome tab into an existing project by projectId, title, or URL.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Project ID, partial project title, or full https://labs.google/... URL.' },
      },
      required: ['target'],
      additionalProperties: false,
    },
  },
  {
    name: 'flow_project_current',
    description: 'Return the active Google Flow project metadata, live URL, auth state, and recent staged drafts.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'flow_page_inspect',
    description: 'Inspect visible buttons, tabs, textboxes, file inputs, and project links on the live Google Flow page.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'flow_asset_list',
    description: 'List assets in the Google Flow asset drawer by category (semua, gambar, video, suara, karakter, avatar, uploaded).',
    inputSchema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['semua', 'gambar', 'video', 'suara', 'karakter', 'avatar', 'uploaded'],
          default: 'semua',
        },
        query: { type: 'string', description: 'Optional search string for Telusuri aset / Search assets.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'flow_asset_upload',
    description: 'Upload one or more local files into the active Google Flow project assets.',
    inputSchema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Absolute paths to local files to upload.',
        },
        category: {
          type: 'string',
          enum: ['uploaded', 'karakter', 'avatar'],
          default: 'uploaded',
        },
      },
      required: ['files'],
      additionalProperties: false,
    },
  },
  {
    name: 'flow_asset_attach',
    description: 'Search for an existing asset in Google Flow and attach it to the current prompt.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Asset name or text to search/match.' },
        category: {
          type: 'string',
          enum: ['semua', 'gambar', 'video', 'suara', 'karakter', 'avatar', 'uploaded'],
          default: 'semua',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'flow_voice_list',
    description: 'List available Google Flow Suara voices (Achernar, Achird, Algenib, Aoede, Charon, Despina, etc.).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional filter by voice name, gender, or pitch/style.' },
        live: { type: 'boolean', description: 'When true, also reads live items from the open Suara tab.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'flow_voice_add',
    description: 'Select a voice in Suara, fill Contoh dialog (max 120 chars) and Sesuaikan performa, and click Tambahkan ke perintah.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Voice name, e.g. Achernar, Charon, Aoede.' },
        dialog: { type: 'string', description: 'Contoh dialog text (max 120 chars).' },
        style: { type: 'string', description: 'Sesuaikan performa / performance style instructions.' },
        preview: { type: 'boolean', description: 'Click Pratinjau before adding to prompt.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'flow_prompt_stage',
    description:
      'Stage uploads, existing asset references, optional Suara voice config, and prompt text into the Google Flow composer WITHOUT clicking Generate (Manual-Only Guardrail).',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Prompt text to place in the Google Flow composer.' },
        title: { type: 'string', description: 'Optional draft title saved in local CLI state.' },
        uploads: { type: 'array', items: { type: 'string' }, description: 'Local asset file paths to upload first.' },
        assets: { type: 'array', items: { type: 'string' }, description: 'Existing asset names to attach.' },
        voice: { type: 'string', description: 'Optional Suara voice name.' },
        voiceDialog: { type: 'string', description: 'Optional Contoh dialog (max 120 chars).' },
        voiceStyle: { type: 'string', description: 'Optional Sesuaikan performa text.' },
        mode: { type: 'string', enum: ['image', 'video'], description: 'Optional composer mode switch.' },
        clear: { type: 'boolean', description: 'Clear existing prompt text before staging.' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'flow_queue_add',
    description:
      'Add a prompt + material shot to the single-tab auto-refill queue without overwriting the active composer prompt. Optionally pre-upload materials.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Prompt text for this queued shot.' },
        title: { type: 'string', description: 'Optional shot title.' },
        uploads: { type: 'array', items: { type: 'string' }, description: 'Local file paths to attach when staged.' },
        assets: { type: 'array', items: { type: 'string' }, description: 'Existing asset names to attach.' },
        voice: { type: 'string', description: 'Optional Suara voice name.' },
        voiceDialog: { type: 'string', description: 'Optional Contoh dialog (max 120 chars).' },
        voiceStyle: { type: 'string', description: 'Optional Sesuaikan performa text.' },
        mode: { type: 'string', enum: ['image', 'video'], description: 'Optional composer mode switch.' },
        preupload: { type: 'boolean', description: 'Pre-upload files to File yang diupload without altering current prompt.' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'flow_queue_list',
    description: 'List all queued shots and counts (pending, staged, submitted).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'flow_queue_next',
    description: 'Mark current staged item submitted and immediately stage the next pending item into the active tab.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'flow_queue_edit',
    description:
      'Revise the current staged shot or an upcoming pending shot (prompt, title, uploads, addUploads, assets, voice, mode) while keeping remaining pending shots saved.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Queue item target: "current", queue id, 1-based index, or title substring.' },
        prompt: { type: 'string', description: 'Replacement prompt text.' },
        title: { type: 'string', description: 'Replacement title.' },
        uploads: { type: 'array', items: { type: 'string' }, description: 'Replace upload file paths.' },
        addUploads: { type: 'array', items: { type: 'string' }, description: 'Append extra upload paths (e.g., last-frame image).' },
        assets: { type: 'array', items: { type: 'string' }, description: 'Replace existing asset queries.' },
        voice: { type: 'string', description: 'Optional Suara voice name.' },
        voiceDialog: { type: 'string', description: 'Optional Contoh dialog.' },
        voiceStyle: { type: 'string', description: 'Optional Sesuaikan performa text.' },
        mode: { type: 'string', enum: ['image', 'video'], description: 'Optional composer mode switch.' },
        preupload: { type: 'boolean', description: 'Pre-upload revised files when not immediately restaging.' },
        restage: { type: 'boolean', description: 'Whether to immediately re-stage in Chrome (defaults true for staged items).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'flow_queue_retry',
    description: 'Re-stage the current staged shot or a matching queued shot in Chrome without advancing the queue.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Queue item target: "current" (default), queue id, 1-based index, or title substring.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'flow_queue_clear',
    description: 'Clear all queued shots (or only submitted items when completedOnly is true).',
    inputSchema: {
      type: 'object',
      properties: {
        completedOnly: { type: 'boolean', description: 'When true, remove only submitted items.' },
      },
      additionalProperties: false,
    },
  },
];

async function executeTool(name, args = {}) {
  switch (name) {
    case 'flow_project_list':
      return cmdProjectList();
    case 'flow_project_create':
      return cmdProjectCreate({ title: args.title || '' });
    case 'flow_project_use':
      return cmdProjectUse(args.target);
    case 'flow_project_current':
      return cmdProjectCurrent();
    case 'flow_page_inspect':
      return cmdProjectInspect();
    case 'flow_asset_list':
      return cmdAssetList({ category: args.category || 'semua', query: args.query || '' });
    case 'flow_asset_upload':
      return cmdAssetUpload({ files: args.files || [], category: args.category || 'uploaded' });
    case 'flow_asset_attach':
      return cmdAssetAttach({ query: args.query || '', category: args.category || 'semua' });
    case 'flow_voice_list':
      return cmdVoiceList({ query: args.query || '', live: Boolean(args.live) });
    case 'flow_voice_add':
      return cmdVoiceAdd({
        name: args.name || '',
        dialog: args.dialog || '',
        style: args.style || '',
        preview: Boolean(args.preview),
      });
    case 'flow_prompt_stage':
      if (args.run || args.submit) {
        throw new Error(
          'Google Flow Manual Generate Guard: automated submission is disabled. Stage only and let the user click Generate.'
        );
      }
      return cmdPromptStage({
        prompt: args.prompt || '',
        title: args.title || '',
        uploads: Array.isArray(args.uploads) ? args.uploads : [],
        assets: Array.isArray(args.assets) ? args.assets : [],
        voice: args.voice || '',
        voiceDialog: args.voiceDialog || '',
        voiceStyle: args.voiceStyle || '',
        mode: args.mode || '',
        clear: Boolean(args.clear),
      });
    case 'flow_queue_add':
      return cmdQueueAdd({
        prompt: args.prompt || '',
        title: args.title || '',
        uploads: Array.isArray(args.uploads) ? args.uploads : [],
        assets: Array.isArray(args.assets) ? args.assets : [],
        voice: args.voice || '',
        voiceDialog: args.voiceDialog || '',
        voiceStyle: args.voiceStyle || '',
        mode: args.mode || '',
        preupload: Boolean(args.preupload),
      });
    case 'flow_queue_list':
      return cmdQueueList();
    case 'flow_queue_next':
      return cmdQueueNext();
    case 'flow_queue_edit':
      return cmdQueueEdit({
        target: args.target || 'current',
        prompt: args.prompt,
        title: args.title,
        uploads: Array.isArray(args.uploads) ? args.uploads : undefined,
        addUploads: Array.isArray(args.addUploads) ? args.addUploads : undefined,
        assets: Array.isArray(args.assets) ? args.assets : undefined,
        voice: args.voice,
        voiceDialog: args.voiceDialog,
        voiceStyle: args.voiceStyle,
        mode: args.mode,
        preupload: Boolean(args.preupload),
        restage: args.restage,
      });
    case 'flow_queue_retry':
      return cmdQueueRetry({ target: args.target || 'current' });
    case 'flow_queue_clear':
      return cmdQueueClear({ completedOnly: Boolean(args.completedOnly) });
    default:
      throw new Error(`Unknown MCP tool: ${name}`);
  }
}

function startMcpServer() {
  return new Promise((resolve) => {
    let buffer = Buffer.alloc(0);
    let useContentLengthFraming = false;

    function sendMessage(msg) {
      const json = JSON.stringify(msg);
      if (useContentLengthFraming) {
        const bytes = Buffer.byteLength(json, 'utf8');
        process.stdout.write(`Content-Length: ${bytes}\r\n\r\n${json}`);
      } else {
        process.stdout.write(json + '\n');
      }
    }

    async function handleRequest(req) {
      if (!req || typeof req !== 'object') return;
      const { id, method, params } = req;

      if (method === 'notifications/initialized' || id === undefined) {
        return;
      }

      try {
        if (method === 'initialize') {
          const clientVersion = (params && params.protocolVersion) || '2024-11-05';
          sendMessage({
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: clientVersion,
              capabilities: { tools: {} },
              serverInfo: {
                name: 'google-flow-canvas-mcp',
                version: pkg.version,
              },
            },
          });
          return;
        }

        if (method === 'ping') {
          sendMessage({ jsonrpc: '2.0', id, result: {} });
          return;
        }

        if (method === 'tools/list') {
          sendMessage({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
          return;
        }

        if (method === 'tools/call') {
          const toolName = params && params.name;
          const toolArgs = (params && params.arguments) || {};
          try {
            const data = await executeTool(toolName, toolArgs);
            sendMessage({
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
              },
            });
          } catch (err) {
            sendMessage({
              jsonrpc: '2.0',
              id,
              result: {
                isError: true,
                content: [{ type: 'text', text: err.message || String(err) }],
              },
            });
          }
          return;
        }

        sendMessage({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        });
      } catch (err) {
        sendMessage({
          jsonrpc: '2.0',
          id,
          error: { code: -32603, message: err.message || String(err) },
        });
      }
    }

    function drainBuffer() {
      while (buffer.length > 0) {
        const text = buffer.toString('utf8');
        if (/^Content-Length:\s*\d+/i.test(text)) {
          useContentLengthFraming = true;
          const headerEnd = buffer.indexOf('\r\n\r\n');
          if (headerEnd === -1) break;
          const header = buffer.slice(0, headerEnd).toString('utf8');
          const match = header.match(/Content-Length:\s*(\d+)/i);
          if (!match) {
            buffer = buffer.slice(headerEnd + 4);
            continue;
          }
          const length = Number(match[1]);
          const bodyStart = headerEnd + 4;
          if (buffer.length < bodyStart + length) break;
          const payload = buffer.slice(bodyStart, bodyStart + length).toString('utf8');
          buffer = buffer.slice(bodyStart + length);
          try {
            handleRequest(JSON.parse(payload));
          } catch {
            // Ignore malformed JSON chunk
          }
        } else {
          const nlIdx = buffer.indexOf('\n');
          if (nlIdx === -1) break;
          const line = buffer.slice(0, nlIdx).toString('utf8').trim();
          buffer = buffer.slice(nlIdx + 1);
          if (!line) continue;
          try {
            handleRequest(JSON.parse(line));
          } catch {
            // Ignore malformed JSON line
          }
        }
      }
    }

    process.stdin.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      drainBuffer();
    });

    process.stdin.on('end', () => resolve());
    process.stdin.resume();
  });
}

if (require.main === module) {
  startMcpServer().catch((err) => {
    process.stderr.write(`MCP server fatal error: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  TOOLS,
  executeTool,
  startMcpServer,
};
