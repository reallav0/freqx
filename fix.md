# Prompt: Investigate and fix high idle RAM/CPU usage in freqx

Paste this whole file as your instructions to the AI working directly in the
`soundmuncher` (freqx) repo. It assumes that AI has file and terminal access
to the real project.

---

## Read first

Before changing anything, read:

- `CONTINUATION-HANDOFF.md` — architecture, safety rules, and what must not
  be broken (crash recovery, mixer routing, security boundaries, packaging).
- `FIX-HEADSET-VIBRATION-BLEED.md` — recent/planned addition of an AEC stage
  ahead of DeepFilterNet3. If that work is present or in progress, account
  for its audio-graph nodes and worklets in your measurements.

## Problem

The packaged app uses roughly **1GB working-set RAM and ~10% CPU** in normal
use. That is high enough to investigate, but do not assume a single cause —
measure first, then fix only what the data shows.

Note for calibration: Discord is also an Electron app and is not itself
lightweight (it commonly sits at 300–500MB+ across its own processes at
idle). The goal is not to match a mythical "native app" baseline — it's to
find and remove *specific* inefficiencies in this app's own code and
configuration, with evidence for each one.

## Step 1 — Get a real per-process breakdown before touching code

Do not guess which process or subsystem is responsible. Add temporary
instrumentation using Electron's own metrics API:

```js
const { app } = require('electron');

setInterval(() => {
  for (const m of app.getAppMetrics()) {
    console.log(
      m.type, m.pid,
      'CPU%', m.cpu.percentCPUUsage,
      'MB', Math.round(m.memory.workingSetSize / 1024)
    );
  }
}, 5000);
```

Capture at minimum these states, each for 60+ seconds of steady state:

1. App freshly launched, window idle, no audio playing, DevTools closed.
2. Same, with DevTools open (rule this in/out explicitly — it's a common
   false signal).
3. Voice isolation **off**.
4. Voice isolation **on**, no one talking.
5. Voice isolation **on**, actively talking.
6. Soundboard idle vs. a sound actively playing.
7. Window minimized / unfocused for 60+ seconds.

Record numbers for each state per process type (`browser`, `renderer`,
`gpu`, `utility`). This table is required in your final report — do not
report a fix without a before/after number tied to a specific state above.

## Step 2 — Check these specific hypotheses, in this order

For each, state in your report whether it was **confirmed**, **partially
responsible**, or **ruled out**, with the measurement that shows it.

1. **DevTools open in the build being measured.** Rule this out first; it
   can by itself account for a large share of renderer RAM/CPU.
2. **Duplicate or un-suspended AudioContexts.** Per the handoff, the
   expected steady state is a small, fixed number of contexts (mixer +
   reusable isolation, plus any AEC-related context/nodes if that work has
   landed). Confirm the actual count in each state above via
   `AudioContext` instance tracking or DevTools' Memory/Performance tab —
   don't rely on source-reading assumptions.
3. **Fully decoded sound assets held in memory.** Check whether every
   bundled/imported WAV is decoded into a full `AudioBuffer` at startup or
   import time, versus only when actually assigned/played. If it's eager,
   quantify the memory cost and consider deferring decode until first use.
4. **WASM linear memory growth that never shrinks.** DeepFilterNet's WASM
   heap can grow under load and stay grown for the rest of the session.
   Compare working set immediately after load vs. after a period of active
   voice isolation use — if it jumps and never comes back down, this is
   confirmed, and the fix is bounding/reinitializing the WASM instance on
   idle rather than expecting shrink-to-fit behavior that WASM doesn't do.
5. **DeepFilterNet3 CPU cost vs. baseline.** Measure the CPU delta between
   voice isolation off vs. on-but-silent vs. on-and-talking. Some CPU cost
   here is expected and acceptable — DeepFilterNet3 is a materially higher
   quality model than Discord's own lightweight suppression model, so it is
   not required to match Discord's CPU number. Report the delta as
   information, not automatically as a bug, unless it's active while
   isolation is supposed to be idle/suspended.
6. **Isolation context not actually suspending when off.** The handoff
   states this was fixed and tested in a fixture; verify it holds in the
   live packaged app, not just in `tests/memory-regression.cjs`. If it is
   still consuming CPU while "Off", this is a regression to fix, not a new
   feature.
7. **`requestAnimationFrame` loops that don't pause when hidden/minimized.**
   Any visualizer, waveform, or animated UI must stop work when
   `document.hidden` is true or the window loses visibility. Check every
   `rAF` loop in `renderer.js`, `discover.js`, and the website's Three.js
   visual (if it shares any renderer code) for a visibility guard.
8. **`backdrop-filter`/blur-heavy CSS running continuously.** This shows up
   as GPU process CPU, not renderer CPU — check the `gpu` row in your
   metrics table specifically, not just `renderer`.

## Constraints — do not violate these while investigating or fixing

- Do not weaken DeepFilterNet quality (e.g. dropping model size/quality) as
  a way to cut CPU without explicit sign-off — that's a product tradeoff,
  not a bug fix.
- Do not touch the hidden crash-recovery/watchdog behavior.
- Do not change soundboard mixer routing or the Discover
  preview-never-touches-shared-mixer guarantee while chasing this.
- Do not add native dependencies (Python, PyTorch, etc.) to solve this.
- Do not reinstate a permanent polling timer as a fix for anything.
- Do not run blanket cleanup, `git reset`, or broad rewrites — this is a
  targeted investigation, not a refactor.
- Keep `contextIsolation: true` and the narrow preload API intact.

## Required deliverable

1. The before/after measurement table from Step 1, filled in for every
   state, both before and after your changes.
2. For each hypothesis in Step 2: confirmed / partially responsible / ruled
   out, with the specific number that supports the conclusion.
3. The specific, scoped fix applied for each confirmed cause — no fix
   without a matching measurement showing it helped.
4. An updated `CONTINUATION-HANDOFF.md` entry documenting the finding and
   fix, in the same table format already used in that file.
5. Explicit note of anything that was investigated and ruled out, so it
   isn't re-investigated by a future session.