# HANDOFF — Never v3 Film Deliverables Generator

## 1. Architecture

### Overview
A Next.js app (never-v2 repo, deployed as never-v3.vercel.app) that generates broadcast deliverables (shot lists, dialogue, graphics, synopses, talent bios, fauna log) from an uploaded video file. All AI work happens **client-side in the browser** — no server functions are involved in upload or analysis.

### Key files
| File | Role |
|------|------|
| `src/lib/store.ts` | Central state + analysis engine. Owns `runAnalysis()`, `shiftTc()`, `tcToSec()`, `truncateHallucinationLoop()`, `applyResults()`, `parseJsonResponse()`, cancel flags, progress map. |
| `src/lib/types.ts` | All shared types: `AnalysisType`, `ShotEntry`, `DialogueEntry`, etc. |
| `src/lib/prompts.ts` | Gemini prompt strings for each analysis type. Includes shared `ANTI_REPETITION_INSTRUCTION` and `TC_INSTRUCTIONS`. |
| `src/lib/export.ts` | CSV export functions. |
| `src/lib/export-industry.ts` | PDF / DOCX export (lazy-loaded). |
| `src/components/DeliverablesPanel.tsx` | Main UI: tabs, action bar, progress display, export menus, per-type result tables. |
| `src/components/Sidebar.tsx` | File upload, settings, version number. |
| `src/components/SettingsPanel.tsx` | Frame rate, drop-frame, language settings. |

### Analysis flow
1. User uploads video → `ai.files.upload()` (Gemini Files API, browser-to-Gemini directly, no server).
2. `runAnalysis(type)` called → video duration checked.
3. Videos > 5 min are split into 5-min chunks (`CHUNK_MINUTES = 5`). Each chunk uses `videoMetadata.startOffset / endOffset` to clip server-side.
4. For each chunk: Gemini 2.5 Flash → JSON response → `truncateHallucinationLoop()` (pre-parse) → `parseJsonResponse()` (3-strategy repair) → `shiftTc()` to convert chunk-relative timecodes to absolute.
5. Results accumulated in `allEntries[]`, deduped at chunk boundaries, then written to store via `applyResults()`.
6. UI subscribes to store via `subscribeAnalysis()`.

### Cancel mechanism (store-level — COMPLETE)
- `_cancelFlags: Map<string, boolean>` — checked at the top of each chunk iteration.
- `cancelAnalysis(type)` / `cancelAllAnalyses()` — exported from store.
- Cancel flag cleared in `finally` block after the loop.

### Progress tracking (store-level — COMPLETE)
- `_analysisProgress: Map<string, { currentMin, totalMin }>` — set before each chunk starts.
- `getAnalysisState()` returns `{ analyzing, errors, progress }` as a snapshot.
- UI reads this via `analysisState.progress[activeTab]`.

---

## 2. Completed Work

### Infrastructure
- [x] All AI calls moved client-side (Gemini Files API from browser) — no Vercel function timeouts.
- [x] GCS + server-side API routes (`get-upload-url`, `register-file`, `file-status`) deleted.
- [x] Deployed as `never-v3.vercel.app` with Deployment Protection disabled for public access.

### Analysis engine (store.ts)
- [x] Chunked analysis with `videoMetadata` clipping (5-min chunks).
- [x] `shiftTc()` converts chunk-relative timecodes to absolute using frame arithmetic.
- [x] `tcToSec()` helper parses TC string to whole seconds (used for absolute-TC detection).
- [x] `parseJsonResponse()` with 3-strategy JSON repair for MAX_TOKENS truncation.
- [x] Per-chunk error isolation (one failed chunk does not abort the whole run).
- [x] Progressive UI updates — results appear after each chunk completes.
- [x] Cancel flags: `cancelAnalysis(type)` / `cancelAllAnalyses()` implemented and wired into chunk loop.
- [x] Dedup at chunk boundaries using `tcIn|tcOut` composite key.
- [x] New upload purges all previous deliverables.
- [x] **v0.3.1 — Timecode double-shift fix:** `processWindow()` now detects if Gemini returned already-absolute TCs (first entry's `tcIn` ≥ chunk `startMin`) and skips shifting. Diagnostic console logs show which path is taken per chunk. Prompt also updated to tell Gemini timecodes must start at `00:00:00:00` relative to the clip.
- [x] **v0.3.2 — Hallucination loop prevention (3-layer):**
  - `ANTI_REPETITION_INSTRUCTION` injected into all 5 list-type prompts (shot_list, dialogue, graphics, talent_bios, fauna_log) — tells Gemini to stop when real content ends.
  - `truncateHallucinationLoop()` scans raw response text for 60-char window repeated ×4, truncates at first repeat and closes JSON cleanly — fires before `parseJsonResponse()`.
  - `maxOutputTokens` reduced 65535 → 32768 — caps how far a loop can run; MAX_TOKENS split-and-retry handles legitimate long content.
  - `dedupeRepetitions()` retained as final safety net.
- [x] **v0.3.3 — Fauna + talent bios hallucination hardening (3-layer, both files):**
  - `parseConfidence()` helper normalises both `"95%"` strings and `0.95` floats.
  - `isValidTc()` helper rejects impossible timecodes (minutes or seconds ≥ 60).
  - `clipEndTC` computed via `shiftTc("00:00:00:00", durationSec, ...)` and injected into `FAUNA_LOG_PROMPT` and `TALENT_BIOS_PROMPT` so Gemini knows the hard ceiling.
  - **Fauna post-processing:** confidence filter (< 0.85 removed) → density cap (max 4 species per 60-second window, lowest confidence dropped first).
  - **Talent bios post-processing:** `appearances` array clamped to ≤ video duration and validated with `isValidTc()`; `firstAppearance` recovered from earliest valid appearance if out-of-bounds; opportunistic cross-reference against `graphicsList` lower-thirds — if graphics have already been run, lower-third TCs are used to correct `firstAppearance` and supplement `appearances`.
  - **Prompt hardening (prompts.ts):** both prompts now include CLIP BOUNDS section; fauna prompt adds CONFIDENCE STANDARD section warning against habitat inference and dense clusters; bios prompt adds FIRST APPEARANCE instruction to scan from frame zero.

### UI (DeliverablesPanel.tsx)
- [x] Elapsed timer (ticks every second while active tab is analyzing).
- [x] Progress text in Generate button: `Min 0–10 / 52` style.
- [x] Thin progress bar strip below action bar (fills proportionally to currentMin/totalMin).
- [x] Tab badges: count + amber pulse dot while running.
- [x] Export All button (header area) with CSV / PDF / DOCX dropdown.
- [x] Per-tab Export dropdown with CSV / PDF / DOCX.
- [x] Talent bios: thumbnails replaced with plain text timecodes (was crashing browser via WebMediaPlayer limit).
- [x] Version number visible in sidebar.
- [x] Cancel buttons wired up in UI: per-tab "Cancel" (action bar), global "Cancel All" (header, next to Generate All), inline Cancel in progress strip. All three call store functions directly.
- [x] Tab completion coloring: `isDone` state drives emerald border/text on tabs with results.

---

## 3. Exact Next Step

### **Test v0.3.3 fauna + bios fixes against a real run**

Before moving to the CSV bug, deploy and run the 52-minute pangolin clip through fauna_log and talent_bios to verify:
- No fauna entries with confidence < 85%
- No dense clusters (> 4 species in 60 seconds)
- No bios appearances beyond clip duration
- `firstAppearance` for Ellen/Luke/Lisa corrected to ~00:01:52–00:02:33 range (matches their lower-thirds in the graphics log)
- Dr Donaldson's invalid `01:71:00:00` timecode rejected

If results still show hallucinations, check the browser console for `[analyze] Fauna:` and `[analyze] Bios:` log lines to see how many entries the filters are removing. If the filters are firing but Gemini is still returning junk at source, consider raising the confidence floor to 0.90.

---

### **Fix CSV column shift** (`src/lib/export.ts`)

**Symptoms:** Exported shot list CSV has 10 data columns but only 8 headers. The "Scene Type" column shows frame numbers ("24", "12") instead of shot type strings.

**Root cause hypothesis:** The CSV row array likely has extra fields vs. the header array. Two candidates:
1. Timecodes contain colons (`00:00:04:00`) which some CSV parsers treat as delimiters if the field isn't quoted correctly.
2. `ShotEntry` objects have extra fields being spread into the row.

**How to confirm:** In `export.ts`, add `console.log('CSV row 0:', rows[0])` just before the CSV is assembled. Count the fields in `rows[0]` vs the header row — if they differ, that's the bug. Also check whether timecode fields are being quoted in the output.

**Key function to read first:** `exportShotList` in `src/lib/export.ts` — look at how the row array is built and compare field count to the header array. Do not touch `store.ts` for this fix.

**Side-effect to check:** After fixing CSV, retest the "535 vs 691 count mismatch" bug — it may resolve automatically if phantom rows were caused by column shift breaking row boundaries.

---

## 4. Known Bugs (Not Yet Fixed)

| Bug | Symptoms | Suspected Cause |
|-----|----------|-----------------|
| **CSV column shift** | 10 data columns for 8 headers; Scene Type shows frame numbers ("24", "12") | See Exact Next Step above. |
| **Count mismatch (dashboard vs CSV)** | Dashboard shows fewer shots than CSV row count | Likely a downstream effect of the CSV column shift creating phantom rows. Test after fixing CSV first. |
| **Talent names "Unidentified"** | Talent bios don't always identify speakers by name | The graphics cross-reference (v0.3.3) partially addresses this — if graphics_list is run first, lower-third names are injected into bios. For videos where names still come back as "Unidentified", the fallback is the two-pass approach described in the prompt's NAME IDENTIFICATION section. |

---

## 5. Pre-existing Tech Debt

| Item | Location | Notes |
|------|----------|-------|
| ~~**TS strict null error**~~ | ~~`store.ts:373`~~ | **Fixed in v0.3.3** — suppressed with `!` non-null assertion; runtime guard upstream makes it safe. |
