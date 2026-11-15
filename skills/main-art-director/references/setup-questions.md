### High-Leverage Configuration & Local Path Questions Before Deployment

Before copying these skills into **Personalized Gemini**, **Google Antigravity IDE** (`~/.gemini/antigravity/skills/<skill-name>/SKILL.md`), and **AWS Kiro Crew** (`.kiro/skills/<skill-name>/SKILL.md`), align these six local environment details so your MCP servers and CLI scripts run with zero friction:

1. **Exact OS & Drive Letter / Mount Paths on Your `i7-14700` Workstation**:
   - Are you running **Windows 11 Pro** (e.g., `D:\PROJECTS\` + `S:\SCRATCH_150GB\`) or **Linux / Dual-Boot**? Locking the exact `<PROJECTS_ROOT>` and `<SCRATCH_150GB>` paths lets you drop a tiny global steering file (`~/.gemini/GEMINI.md` and `.kiro/steering/workstation.md`) so every skill writes cache, Topaz selects, and ProRes 4444 intermediates to the exact NVMe partition automatically.
2. **Discrete GPU Pairing with Your Intel Core i7-14700**:
   - Which discrete GPU (e.g., NVIDIA RTX 4070 / 4070 Ti Super / 4080) sits on your Gigabyte B760M DS3H? Knowing exact VRAM (`12 GB` vs `16 GB+`) allows `#5 video-editor` (Topaz Video AI + Resolve Neural Engine / Temporal NR) and `#6 3d-modeler-rig-animator` (Blender Cycles `OPTIX` vs `CPU` OIDN tile sizing) to lock optimal batch/sample limits without VRAM OOM crashes.
3. **DaVinci Resolve License Tier (Studio 21 vs Free 21)**:
   - `samuelgursky/davinci-resolve-mcp` requires **DaVinci Resolve Studio** on v21.1+ (`Preferences > General > External scripting using > Local`) because Blackmagic gated external Python scripting and Magic Mask/Dehancer/Halation OFX to Studio. Confirming Studio 21.x lets `#5` use live MCP execution vs. offline `.fcpxml`/`.otio`/`.drx` generation.
4. **Which Local Adobe MCP Bridge You Prefer Today**:
   - While waiting for Adobe’s Official Local MCP beta (early 2027), confirm which local bridge repo you want standardized in your `mcp_config.json` across Antigravity and Kiro:
     - **Unified Suite**: `mikechambers/adb-mcp` (covers Photoshop + Premiere via UXP/Node WebSocket proxy) + `kumoproductions/mcp-aftereffects` (file-IPC undo-safe AE bridge).
     - **Deep Photoshop Specialist**: `Immersive-Media-Technologies/photoshop-mcp-imt` (135 tools behind a compact 5-tool MCP facade so Antigravity/Kiro context stays tiny).
5. **Sony A7 III Picture Profile Standard for Teras Imaji & Solgates Visual**:
   - Do you shoot your Sony A7 III primarily in **`PP8` (`S-Log2 / S-Gamut3.Cine`)**, **`PP10` (`HLG3 / BT.2020`)**, or **`PP6` (`Cine4`)**? Setting your default profile in `.kiro/steering/` lets `#5 video-editor` pre-populate **Node 02 (`CST_IN`)** in DaVinci Resolve without asking on every property shoot.
6. **Master Brand Typography & Swatch Defaults**:
   - If **Solgates Visual**, **Teras Imaji**, and your **in-house luxury high-rise residential brand** have locked primary/secondary font families (`.otf`/`.ttf` or Google/Adobe Fonts) and signature brand hex codes, store them in a shared Figma file or `brand-tokens.json` so `#2 key-visual-graphic-designer` and `#4 motion-designer-director` pull them automatically via Figma MCP (`get_variable_defs`) and Remotion/HyperFrames font loaders.
