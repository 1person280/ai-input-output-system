# Autonomous file creation

The extension can turn a natural-language **requirement** into real files inside
the workspace — no hand-written content. The flow has three stages:
**decode → plan → write**.

```
requirement ──▶ planParser  (local model first)
                       │  unavailable / unparsable ▼
                       │            cloud model
                       │  unavailable / unparsable ▼
                       │        heuristicPlanner (offline)
                       ▼
              FilePlan { files[], source, requirement }
                       │
                       ▼
        vscode.workspace.fs.writeFile  (parents auto-created)
```

## The three plan sources

| Source | When it is used | Notes |
| --- | --- | --- |
| `local` | A `llama-server` answers `/health` and returns parsable JSON | Prefers the on-device model. |
| `cloud` | Local is unreachable, unconfigured, or its output cannot be parsed | Uses the OpenAI-compatible endpoint. |
| `heuristic` | Both local and cloud are unavailable | Pure, offline fallback that **always** produces a file. |

The `heuristic` fallback is deliberately not a stub: it extracts any `*.ext`
file names mentioned in the requirement (e.g. `main.py`, `config.json`) and, if
there are none, infers a sensible name from keywords
(`python`/`脚本` → `main.py`, `readme`/`说明` → `README.md`,
`typescript`/`ts` → `main.ts`, `json`/`配置` → `config.json`, otherwise
`notes.md`). The generated body embeds the **requirement text itself** and adds
a skeleton that matches the file type (a runnable `def main()` for `.py`, a
title + bullets for `.md`, a valid object for `.json`, and so on), so the
offline path produces a meaningful file on its own.

All planned paths are **relative**; absolute paths and any `..` traversal are
rejected before anything touches disk.

## Configuration

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `aiio.autonomousOnStartup` | boolean | `false` | Run the startup creation on activation. |
| `aiio.autonomousRequirement` | string | `""` | Requirement used at startup; empty disables the run. |
| `aiio.targetSubdirectory` | string | `aiio-generated` | Workspace-relative folder every generated file lands in. |

## Command

`aiio.createFromRequirement` — **AI I/O: Create Files From Requirement**. It
pre-fills the input box with `aiio.autonomousRequirement`, runs the orchestrator,
then lists the created files and offers an **open file** button.

## How to verify

1. Open the **Output** panel and pick the **AI I/O System** channel. Every run
   logs the requirement, which source was chosen (`来源=local|cloud|heuristic`),
   each written path, and why any higher-priority source was skipped.
2. Run the command (or enable `aiio.autonomousOnStartup` + set
   `aiio.autonomousRequirement`) and look under
   `<workspace>/<aiio.targetSubdirectory>`.
3. To force the offline path, stop `llama-server` and clear `aiio.cloudApiKey`;
   the log should show `启用离线启发式规划` and a file still appears with
   `source=heuristic`.

The parser and heuristic planner are pure functions (`planParser`,
`heuristicPlanner`) with no `vscode` import, so the whole planning stage is
covered by Vitest without an editor host.