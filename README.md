# Google Flow Canvas CLI & Multi-Agent Art Director Suite

`flow-canvas` (`google-flow`) is a local CLI and stdio MCP bridge over Chrome CDP (`http://127.0.0.1:9222`) for **Google Labs Flow** (`flow.google.com` / `labs.google/fx/tools/flow`), bundled together with **25 creative & Art Director skills** ready to install across **Antigravity (`.gemini`)**, **Kiro (`.kiro`)**, and **Claude (`.claude`)**.

> **Manual-Only Generation Guardrail**: `flow-canvas` uploads assets, configures `Suara` voices, stages prompts, and manages persistent shot queues — it **never** clicks Generate (`--run`, `--submit`, `node run`, and `prompt submit` are blocked with exit code `13`).

---

## What Is Included

- **CLI & MCP Bridge** (`bin/flow-canvas.js`, `src/`):
  - `project ls | create | use | current | inspect`
  - `asset ls | upload | attach`
  - `voice list | add | preview`
  - `prompt stage`
  - `queue add | ls | next | edit | retry | watch | clear` (persistent `.google-flow-cli/state.json` queue supporting `"continue"` / `"pause & revise"` workflows)
  - `mcp` (stdio JSON-RPC 2.0 server with `flow_*` tools)
- **Bundled Skills (`skills/`, 25 total)**:
  - Google Flow & Dreamina: `google-flow-cli`, `dreamina-canvas-cli`
  - Art Director Pipeline: `main-art-director`, `film-art-director`, `key-visual-graphic-designer`, `ads-campaign-director`, `motion-designer-director`, `3d-modeler-rig-animator`, `video-editor`, `sound-designer`
  - Quality Filters: `antislop`, `antislop-code`, `antislop-copywriting`, `antislop-human`, `antislop-layoutmobile`, `antislop-ui`
  - Motion & Design: `figma`, `hyperframes`, `hyperframes-cli`, `hyperframes-registry`, `media-use`, `remotion-to-hyperframes`, `reverse-any-video`, `slideshow`, `style-sampling`
- **One-Command Installer**: `setup.ps1`

---

## Install on a New PC (Windows PowerShell)

Prerequisites: **Node.js** (18+) and **Google Chrome** (or Chromium).

```powershell
git clone https://github.com/solgates/google-flow-connects.git "Google-Flow-Connects"
cd "Google-Flow-Connects"
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

What `setup.ps1` does automatically:
1. Installs npm dependencies (`playwright-core`).
2. Writes `flow-canvas` / `google-flow` shims into `%USERPROFILE%\bin` and adds `%USERPROFILE%\bin` to your User `PATH`.
3. Syncs all 25 bundled skills into:
   - `%USERPROFILE%\.gemini\config\skills\` (**Antigravity**)
   - `%USERPROFILE%\.kiro\skills\` (**Kiro**)
   - `%USERPROFILE%\.claude\skills\` (**Claude**)

To install only for specific agents, pass `-Agents`:

```powershell
.\setup.ps1 -Agents kiro,claude
```

---

## First-Time Google Flow Login (Per PC)

Open Chrome and sign into Google Flow once using the dedicated CDP profile (`%USERPROFILE%\.google-flow-cli\chrome-profile`):

```powershell
flow-canvas auth login
flow-canvas auth status
```

---

## Updating Across PCs

Pull your latest changes and re-run setup (pass `-SkipNpm` if dependencies haven't changed):

```powershell
git pull
powershell -ExecutionPolicy Bypass -File .\setup.ps1 -SkipNpm
```

---

## Claude Desktop Integration (Connectors, Plugins & Skills)

You can connect **Google Flow** and all **25 bundled skills** to Claude Desktop in three ways:

1. **Automatic Local Setup (Recommended)**:
   Run `powershell -ExecutionPolicy Bypass -File .\setup.ps1`. This automatically:
   - Closes running Claude Desktop windows before updating config files so Claude does not overwrite them on exit
   - Installs the **Google Flow** Desktop Extension Connector (`Claude Extensions\local.solgates.google-flow`) so **Google Flow** appears in **Customize -> Connectors -> Yours**
   - Registers `google-flow` in `claude_desktop_config.json` (`%LOCALAPPDATA%\Claude-Data\claude_*`, `%APPDATA%\Claude`, and `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude`)
   - Installs `google-flow-connects@local-desktop-app-uploads` as a local Cowork Plugin with all 25 skills enabled
   - Generates `dist/google-flow-connects.plugin`

2. **Install via GitHub URL in Claude Desktop**:
   Open **Settings -> Customize -> Plugins -> + Add** in Claude Desktop and add this GitHub repository:
   - `https://github.com/solgates/google-flow-connects` (or `solgates/google-flow-connects`)

3. **Upload the Packaged `.plugin` Bundle**:
   In Claude Desktop **Settings -> Customize -> Plugins -> + Add**, choose upload/local package and select `dist/google-flow-connects.plugin`.

> **Other Agents**: `%USERPROFILE%\.claude\skills\` is synced for Claude Code/CLI, `%USERPROFILE%\.kiro\skills\` for Kiro, and `%USERPROFILE%\.gemini\config\skills\` for Antigravity.

For **Antigravity** or **Kiro** (`.kiro/settings/mcp.json`, or `~/.claude.json` for Claude Code), you can also register:

```json
{
  "mcpServers": {
    "google-flow": {
      "command": "flow-canvas",
      "args": ["mcp"]
    }
  }
}
```
