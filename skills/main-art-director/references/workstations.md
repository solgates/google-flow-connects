# Workstation Profiles

Pick the profile by computer name (`$env:COMPUTERNAME` in PowerShell). If the name matches no profile, ask the Director which machine this is before any download or render.

The laptop is the master Kiro setup; the office PC follows it. Both profiles live in this one file so the same skills work on both machines.

---

## Profile 1: Laptop (`COMPUTERNAME = MSI`)

| Drive | What | Size / free (checked 2026-11-13) | Use |
| :--- | :--- | :--- | :--- |
| `D:` "Project File" | NVMe SSD partition | 12.9 GB / 12.9 GB | Active project only (`<PROJECTS_ROOT>` = `D:\PROJECTS\`) |
| `C:` "Windows" | NVMe SSD (same disk) | 445 GB / 75 GB | System and apps. Don't fill it with project media |
| `H:` | USB HDD, 1 TB (slow, can be unplugged) | 932 GB / 179 GB | Archive and backup of finished stages. Not for live editing or cache |

### Disk Budget (Replaces the 150 GB Scratch Rule on This Machine)
- **Keep at least 3 GB free on `D:`.** Working budget is about 10 GB.
- **Warn at 8 GB used** on `D:` and propose moving finished stages to `H:`.
- Show `D:` free space in every Execution Plan that downloads or renders files: `Get-Volume -DriveLetter D`.
- Gate G4 on this machine: `D:` has at least 3 GB free (instead of "scratch < 120 GB").

### What Runs on the Laptop
- Pre-production: scripts, storyboards, moodboards, color scripts, `DESIGN.md`.
- Prompts, Dreamina runs (`dreamina-canvas`, cloud render) and Flow Packets.
- Scoring takes with Keeper Cards, review cuts, light edits with proxies.
- Mode A greybox stills in Blender (few frames, low samples).

### What Waits for the Office PC
- Topaz Video AI upscales.
- ProRes 4444 alpha exports and Blender EXR / Cycles multi-frame renders.
- 4K masters and long Resolve or Premiere renders.
- Any single job estimated above 3 GB of output.

### File Habits on the Laptop
- Download review copies only (720p or 1080p). Get the 4K / full-quality copy on the office PC.
- After scoring, delete rejected takes from `D:`. Their `submit_id` / node ID stays in `00_BRIEF_SPECS/dreamina_tasks.json`, so they can be downloaded again.
- Resolve and Adobe media caches: set a small cap (about 2 GB) and clear them when a stage is signed off.
- Before moving to `H:`, check it is plugged in (`Test-Path H:\`). Copy first, check the copy, then delete from `D:` only with the Director's OK.

---

## Profile 2: Office PC (Any Other Name, Confirm First)

- Intel Core i7-14700, Samsung 990 NVMe, **150 GB dedicated scratch partition**.
- Uses the original rules in `main-art-director` §1 and Guardrail 3 (150 GB cap, Gate G4 "scratch < 120 GB").
- Computer name, drive letters and GPU not recorded yet: ask once, then add them here (see `setup-questions.md` questions 1 and 2).
- Heavy jobs from the laptop's "waits for the office PC" list run here.
