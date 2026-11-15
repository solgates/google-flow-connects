---
name: google-flow-cli
description: >
  Use this Skill for image, video, character, avatar, and voice ("Suara") workflows inside Google Flow (`labs.google/fx/tools/flow`) using the `flow-canvas` (alias `google-flow`) CLI and MCP bridge over Chrome CDP.
  Supports creating or entering Flow projects, uploading material assets, configuring voices ("Contoh dialog" and "Sesuaikan performa"), attaching assets, and staging prompts in draft/manual-generate mode.
---

# Google Flow Canvas CLI (`flow-canvas`)

Use this Skill whenever the user asks an AI agent (Antigravity, Kiro, or another host) to create, open, inspect, upload assets to, configure voices for, or stage prompts inside a **Google Flow** project.

## Interaction and usage principles

1. **Keep progress messages brief.** Run routine `version`, `schema`, `auth status`, `project current`, and `voice list` checks directly without narrating every command.
2. **Reuse the same Chrome CDP session.** `flow-canvas` automatically launches or attaches to Chrome on CDP port `9222` using `%USERPROFILE%\.google-flow-cli\chrome-profile` and reuses the active Google Flow tab instead of opening duplicate tabs.
3. **Manual-only generation by default.** Never click **Generate** inside Google Flow on the user's behalf unless the user explicitly performs it themselves in the browser. Always stage assets, voices, and prompts in the composer, then hand off the clickable `webUrl`.
4. **Share the project link immediately.** After creating or entering a project (`project create` / `project use`), send the user the returned `webUrl` so they can inspect the live canvas and press Generate when ready.

## Preflight

Inspect the live CLI schema and browser auth state before writing to a project:

```powershell
flow-canvas version
flow-canvas schema
flow-canvas auth status
```

If `needsLogin` is `true` (exit code `11` on write commands), tell the user to sign into their Google account in the opened Chrome window (`flow-canvas auth login` brings it to front), wait for them to finish signing in, and then continue.

## Project management (`project` / `canvas`)

Supports both `project` and Dreamina-compatible `canvas` subcommands:

```powershell
# List projects discovered in Flow UI and local state
flow-canvas project ls

# Create a new Flow project and make it active
flow-canvas project create --title "Product Spot"

# Enter an existing project by ID, title substring, or full URL
flow-canvas project use <project-id-or-url>

# Inspect active project and live composer/drawer state
flow-canvas project current
flow-canvas project inspect
```

## Asset management (`asset` / `resource`)

Supports Indonesian and English Google Flow UI tabs:
- `semua` (`all`)
- `gambar` (`image`)
- `video`
- `suara` (`voice`)
- `karakter` (`character`)
- `avatar`
- `uploaded` (`File yang diunggah` / `Uploaded files`)

```powershell
# List visible assets in a category (optionally filter via Telusuri aset)
flow-canvas asset ls --category uploaded --query "hero"

# Upload local material assets into Google Flow
flow-canvas asset upload .\hero.png .\product-angle.png --category uploaded

# Attach an existing asset to the current prompt
flow-canvas asset attach "hero" --category uploaded
```

## Voice ("Suara") discovery and configuration (`voice`)

Google Flow voices include `Achernar`, `Achird`, `Algenib`, `Algieba`, `Alnilam`, `Aoede`, `Autonoe`, `Callirrhoe`, `Charon`, `Despina`, `Enceladus`, and other Gemini/Chirp voices.

```powershell
# List catalog voices (add --live to also read the open Suara tab)
flow-canvas voice list
flow-canvas voice list --query female

# Configure a voice ("Contoh dialog" max 120 chars + "Sesuaikan performa") and click "Tambahkan ke perintah"
flow-canvas voice add --name "Achernar" `
  --dialog "Halo! Kami memperkenalkan fitur baru yang terdengar alami." `
  --style "Warm, soft, cinematic narration"

# Preview a voice without adding it to the prompt
flow-canvas voice preview --name "Charon" --dialog "Welcome to the future."
```

Constraints:
- `Contoh dialog` (`--dialog`) has a **120-character limit** in the Google Flow UI; `flow-canvas` automatically caps at 120 characters and reports `dialogTruncated: true` if shortened.
- Never translate or alter canonical voice names (`Achernar`, `Aoede`, `Charon`, etc.).

## Staging prompts (`prompt stage` / `node create`)

Stage uploads, asset references, voice configuration, and prompt text in a single command (or step-by-step), **without clicking Generate**:

```powershell
flow-canvas prompt stage "Medium tracking shot of the bottle on wet volcanic stone, warm rim light." `
  --title "Shot 01 - Hero Bottle" `
  --mode video `
  --upload .\hero.png `
  --voice "Achernar" `
  --voice-dialog "Rasakan kesegaran alami di setiap tetes." `
  --voice-style "Soft, intimate commercial whisper" `
  --clear
```

Dreamina-compatible alias also works:

```powershell
flow-canvas node create video --prompt "Cinematic aerial sweep..." --title "Shot 02" --upload .\ref.png
```

## Step-by-step review & auto-refill queue (`queue`)

Google Flow only has one prompt composer per Chrome tab. Use `queue` when a multi-shot plan (or Art Director batch) is approved so Shot 1 is staged now and Shots `2..N` stay saved in `.google-flow-cli/state.json` ready for `"continue"` or `"pause & revise"`:

```powershell
# 1. Queue approved shots and pre-upload all reference assets without disturbing Shot 1
flow-canvas queue add "Tracking shot through the consultation corridor..." `
  --title "sh020" `
  --upload .\ref1.png --upload .\ref2.png `
  --preupload

# 2. Stage Shot 1 (or advance to the next pending shot when the user says "continue" / "next")
flow-canvas queue next

# 3. Inspect remaining pending / staged / submitted items at any time
flow-canvas queue ls

# 4. Pause & revise without losing the remaining pending batch:
#    - Revise the currently staged shot (auto re-stages in Chrome without advancing)
flow-canvas queue edit --current --prompt "Updated tighter lens and dusk window rim light..."
#    - Or update an upcoming queued shot (e.g., attach Shot 1's exported last frame to Shot 2)
flow-canvas queue edit 2 --add-upload .\sh010_last_frame.png --preupload
#    - Re-stage the current shot manually if needed
flow-canvas queue retry

# 5. Optional continuous watcher: auto-refills each next shot (~1.2s) right after clicking Generate
flow-canvas queue watch

# Clear submitted or all queued shots
flow-canvas queue clear --completed
flow-canvas queue clear
```

## Manual-Only Generation Guardrail

`flow-canvas` enforces the same manual-generation safety model as `dreamina-manual-generate-guard`:
- Blocked flags: `--run`, `--submit`
- Blocked subcommands: `node run`, `node confirm`, `prompt run`, `prompt submit`
- Passing any blocked flag or subcommand exits with code **`13`** and refuses execution.
- After staging completes, report the staged items and clickable `webUrl`, and tell the user the prompt is ready for them to click **Generate** inside Google Flow.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Runtime or DOM selector error (run `flow-canvas project inspect` to check live UI) |
| `2` | Invalid arguments or usage error |
| `11` | Google sign-in required in the CDP Chrome window (`flow-canvas auth login`) |
| `13` | Blocked by Manual-Only Generation Guardrail (`--run`, `node run`, etc.) |

## MCP integration (`flow-canvas mcp`)

Both Antigravity and Kiro can alternatively connect via stdio MCP using `"command": "flow-canvas", "args": ["mcp"]`:
- `flow_project_list`, `flow_project_create`, `flow_project_use`, `flow_project_current`, `flow_page_inspect`
- `flow_asset_list`, `flow_asset_upload`, `flow_asset_attach`
- `flow_voice_list`, `flow_voice_add`
- `flow_prompt_stage`
- `flow_queue_add`, `flow_queue_list`, `flow_queue_next`, `flow_queue_edit`, `flow_queue_retry`, `flow_queue_clear`
