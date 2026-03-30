"use client";

import { Project, Deliverables, ProjectStatus, AnalysisJob, AnalysisType, FrameRate } from "./types";
import { MediaResolution } from "@google/genai";
import {
  SHOT_LIST_PROMPT,
  DIALOGUE_LIST_PROMPT,
  GRAPHICS_LIST_PROMPT,
  SYNOPSES_PROMPT,
  TALENT_BIOS_PROMPT,
  FAUNA_LOG_PROMPT,
} from "./prompts";

// In-memory client-side store (zustand-like but zero-dep)
type Listener = () => void;

interface Store {
  project: Project | null;
  jobs: AnalysisJob[];
  apiKey: string;
  videoBlobUrl: string | null;
  setApiKey: (key: string) => void;
  setProject: (project: Project | null) => void;
  updateProject: (updates: Partial<Project>) => void;
  updateDeliverables: (updates: Partial<Deliverables>) => void;
  setProjectStatus: (status: ProjectStatus) => void;
  setJobs: (jobs: AnalysisJob[]) => void;
  updateJob: (jobId: string, updates: Partial<AnalysisJob>) => void;
  setVideoBlobUrl: (url: string | null) => void;
  subscribe: (listener: Listener) => () => void;
  getState: () => { project: Project | null; jobs: AnalysisJob[]; apiKey: string; videoBlobUrl: string | null };
}

function createStore(): Store {
  let state = {
    project: null as Project | null,
    jobs: [] as AnalysisJob[],
    apiKey: "",
    videoBlobUrl: null as string | null,
  };
  const listeners = new Set<Listener>();

  function notify() {
    listeners.forEach((l) => l());
  }

  return {
    get project() { return state.project; },
    get jobs() { return state.jobs; },
    get apiKey() { return state.apiKey; },
    get videoBlobUrl() { return state.videoBlobUrl; },

    setApiKey(key: string) {
      state = { ...state, apiKey: key };
      if (typeof window !== "undefined") {
        localStorage.setItem("gemini_api_key", key);
      }
      notify();
    },

    setProject(project: Project | null) {
      state = { ...state, project };
      notify();
    },

    updateProject(updates: Partial<Project>) {
      if (!state.project) return;
      state = { ...state, project: { ...state.project, ...updates, updatedAt: new Date().toISOString() } };
      notify();
    },

    updateDeliverables(updates: Partial<Deliverables>) {
      if (!state.project) return;
      state = {
        ...state,
        project: {
          ...state.project,
          deliverables: { ...state.project.deliverables, ...updates },
          updatedAt: new Date().toISOString(),
        },
      };
      notify();
    },

    setProjectStatus(status: ProjectStatus) {
      if (!state.project) return;
      state = { ...state, project: { ...state.project, status, updatedAt: new Date().toISOString() } };
      notify();
    },

    setJobs(jobs: AnalysisJob[]) {
      state = { ...state, jobs };
      notify();
    },

    updateJob(jobId: string, updates: Partial<AnalysisJob>) {
      state = {
        ...state,
        jobs: state.jobs.map((j) => (j.id === jobId ? { ...j, ...updates } : j)),
      };
      notify();
    },

    setVideoBlobUrl(url: string | null) {
      // Revoke old blob URL to free memory
      if (state.videoBlobUrl && state.videoBlobUrl !== url) {
        URL.revokeObjectURL(state.videoBlobUrl);
      }
      state = { ...state, videoBlobUrl: url };
      // Clear frame cache so stale thumbnails from the old video don't bleed into the new one
      if (typeof window !== "undefined") {
        import("./frames").then((m) => m.clearFrameCache()).catch(() => {});
      }
      notify();
    },

    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    getState() {
      return state;
    },
  };
}

// Always create the store — it's harmless on the server since it's just in-memory
const _store = createStore();
export const store = _store;

// Hydrate from localStorage — MUST be called inside useEffect to avoid hydration mismatch
// (server renders with apiKey="" but client would have the saved key, causing React #185)
let _hydrated = false;
export function hydrateStore() {
  if (_hydrated || typeof window === "undefined") return;
  _hydrated = true;
  const savedKey = localStorage.getItem("gemini_api_key");
  if (savedKey) _store.setApiKey(savedKey);
}

// Track running analyses so they survive component unmounts
const _analyzing = new Map<string, boolean>();
const _analysisErrors = new Map<string, string>();
// Progress: { currentMin, totalMin } — only set while chunked analysis is running
const _analysisProgress = new Map<string, { currentMin: number; totalMin: number }>();
// Cancel flags — checked between chunks; setting to true aborts the analysis loop gracefully
const _cancelFlags = new Map<string, boolean>();
// AbortControllers — aborted immediately on cancel to kill the in-flight Gemini request
const _abortControllers = new Map<string, AbortController>();
const _analysisListeners = new Set<Listener>();

function notifyAnalysis() {
  _cachedAnalysisState = null; // invalidate cached snapshot
  _analysisListeners.forEach((l) => l());
}

// Cached snapshot — only rebuilt when notifyAnalysis() invalidates it
let _cachedAnalysisState: {
  analyzing: Record<string, boolean>;
  errors: Record<string, string>;
  progress: Record<string, { currentMin: number; totalMin: number }>;
} | null = null;

export function getAnalysisState(): {
  analyzing: Record<string, boolean>;
  errors: Record<string, string>;
  progress: Record<string, { currentMin: number; totalMin: number }>;
} {
  if (!_cachedAnalysisState) {
    _cachedAnalysisState = {
      analyzing: Object.fromEntries(_analyzing) as Record<string, boolean>,
      errors: Object.fromEntries(_analysisErrors) as Record<string, string>,
      progress: Object.fromEntries(_analysisProgress) as Record<string, { currentMin: number; totalMin: number }>,
    };
  }
  return _cachedAnalysisState;
}

export function subscribeAnalysis(listener: Listener) {
  _analysisListeners.add(listener);
  return () => _analysisListeners.delete(listener);
}

/** Signal a running analysis to stop — aborts the in-flight request immediately. */
export function cancelAnalysis(type: AnalysisType) {
  if (_analyzing.get(type)) {
    _cancelFlags.set(type, true);
    _abortControllers.get(type)?.abort();
    notifyAnalysis();
  }
}

/** Cancel ALL running analyses immediately. */
export function cancelAllAnalyses() {
  for (const [type, running] of _analyzing) {
    if (running) {
      _cancelFlags.set(type, true);
      _abortControllers.get(type)?.abort();
    }
  }
  notifyAnalysis();
}

function getPrompt(
  type: AnalysisType,
  frameRate: FrameRate,
  dropFrame: boolean,
  language: string,
  clipEndTC: string
): string {
  switch (type) {
    case "shot_list": return SHOT_LIST_PROMPT(frameRate, dropFrame, language);
    case "dialogue_list": return DIALOGUE_LIST_PROMPT(frameRate, dropFrame, language);
    case "graphics_list": return GRAPHICS_LIST_PROMPT(frameRate, dropFrame, language);
    case "synopses": return SYNOPSES_PROMPT(language);
    case "talent_bios": return TALENT_BIOS_PROMPT(frameRate, dropFrame, language, clipEndTC);
    case "fauna_log": return FAUNA_LOG_PROMPT(frameRate, dropFrame, language, clipEndTC);
  }
}

// Types that produce many entries per minute and need chunking for long videos
const CHUNKED_TYPES: AnalysisType[] = ["shot_list", "dialogue_list", "graphics_list", "fauna_log"];
// Chunk size in minutes — 5 min prevents MAX_TOKENS hallucination on dense documentary footage.
// At 10 min, Gemini fills the tail of its output budget with repetitive identical shots.
const CHUNK_MINUTES = 5;
// Minimum video duration (seconds) before chunking kicks in
const CHUNK_THRESHOLD_SEC = 25 * 60; // 25 minutes

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseJsonResponse(responseText: string): any {
  try {
    return JSON.parse(responseText);
  } catch {
    const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
    const raw = jsonMatch ? jsonMatch[1].trim() : responseText;
    try {
      return JSON.parse(raw);
    } catch {
      console.warn("[analyze] JSON truncated, attempting repair...");

      // Primary repair: find last "}, " boundary (end of a complete entry).
      // Bracket-counting is unreliable when truncation happens inside a string value
      // (e.g. "tcOut": "00:10) because { } [ ] inside strings get miscounted.
      const lastEntryBoundary = raw.lastIndexOf("},");
      if (lastEntryBoundary > 0) {
        const partial = raw.slice(0, lastEntryBoundary + 1); // include the }
        const trimmed = partial.trimStart();
        const repaired = trimmed.startsWith("[") ? partial + "]" : partial + "]}";
        try {
          const result = JSON.parse(repaired);
          console.log("[analyze] Repaired truncated JSON via entry boundary");
          return result;
        } catch { /* fall through */ }
      }

      // Second fallback: flat object truncated mid-string (e.g. synopses).
      // A flat JSON object has no }, boundaries — but complete fields end with ",\n.
      // Using ",\n avoids false-positives from escaped \" inside string values.
      const lastFieldNewline = raw.lastIndexOf('",\n');
      const lastFieldBoundary = lastFieldNewline > 0 ? lastFieldNewline : raw.lastIndexOf('",');
      if (lastFieldBoundary > 0 && raw.trimStart().startsWith("{")) {
        const partial = raw.slice(0, lastFieldBoundary + 1); // include closing "
        const repaired = partial + "\n}";
        try {
          const result = JSON.parse(repaired);
          console.log("[analyze] Repaired truncated flat object via field boundary");
          return result;
        } catch { /* fall through */ }
      }

      // Third fallback: close open brackets/braces (works when truncation is outside strings)
      const lastCompleteObj = raw.lastIndexOf("}");
      if (lastCompleteObj > 0) {
        let repaired = raw.slice(0, lastCompleteObj + 1);
        const opens = (repaired.match(/\[/g) || []).length;
        const closes = (repaired.match(/\]/g) || []).length;
        for (let i = 0; i < opens - closes; i++) repaired += "]";
        const openBraces = (repaired.match(/\{/g) || []).length;
        const closeBraces = (repaired.match(/\}/g) || []).length;
        for (let i = 0; i < openBraces - closeBraces; i++) repaired += "}";
        try {
          const result = JSON.parse(repaired);
          console.log("[analyze] Repaired truncated JSON via bracket-count");
          return result;
        } catch {
          console.error("[analyze] Repair failed:", repaired.slice(-200));
          throw new Error("Failed to parse AI response as JSON (truncated)");
        }
      }
      console.error("[analyze] Failed to parse:", raw.slice(0, 500));
      throw new Error("Failed to parse AI response as JSON");
    }
  }
}

function formatMinSec(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = Math.floor(totalMinutes % 60);
  const s = Math.round((totalMinutes % 1) * 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * Run analysis directly in the browser using @google/genai SDK.
 * For long videos (>25 min), automatically chunks time-dense analysis types
 * (shot_list, dialogue_list, graphics_list, fauna_log) into 20-minute segments.
 * synopses and talent_bios always run as single calls (they need full context).
 */
export async function runAnalysis(type: AnalysisType) {
  const state = _store.getState();
  const project = state.project;
  const apiKey = state.apiKey;
  if (!project?.videoFile?.geminiFileUri || !apiKey) return;
  if (_analyzing.get(type)) return; // already running

  _analyzing.set(type, true);
  _analysisErrors.set(type, "");
  _analysisProgress.delete(type);
  notifyAnalysis();

  try {
    const { GoogleGenAI } = await import("@google/genai");
    const ai = new GoogleGenAI({ apiKey });

    const frameRate = project.settings.frameRate;
    const dropFrame = project.settings.dropFrame;
    const durationSec = project.videoFile.duration || 0;
    const needsChunking = CHUNKED_TYPES.includes(type) && durationSec > CHUNK_THRESHOLD_SEC;
    console.log(`[analyze] Video duration: ${durationSec}s, needsChunking: ${needsChunking}`);

    const clipEndTC = shiftTc("00:00:00:00", durationSec, frameRate, dropFrame);
    const basePrompt = getPrompt(type, frameRate, dropFrame, project.settings.language, clipEndTC);

    // Build time chunks
    const chunks: { startMin: number; endMin: number }[] = [];
    if (needsChunking) {
      const totalMin = durationSec / 60;
      for (let start = 0; start < totalMin; start += CHUNK_MINUTES) {
        chunks.push({ startMin: start, endMin: Math.min(start + CHUNK_MINUTES, totalMin) });
      }
      console.log(`[analyze] Video is ${totalMin.toFixed(1)} min — splitting ${type} into ${chunks.length} chunks of ${CHUNK_MINUTES} min`);
    } else {
      chunks.push({ startMin: 0, endMin: durationSec / 60 });
    }

    const t0 = Date.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allEntries: any[] = [];
    let shotCounter = 0;

    // Create a fresh AbortController for this run so cancel() can kill the active request
    const abortController = new AbortController();
    _abortControllers.set(type, abortController);

    // Process a single time window. On MAX_TOKENS failure, splits in half and retries
    // recursively (up to depth 2, giving a minimum window of ~1.25 min).
    // This prevents silent gaps when a 5-min chunk overflows the output budget.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const processWindow = async (startMin: number, endMin: number, depth: number): Promise<any[]> => {
      if (abortController.signal.aborted || _cancelFlags.get(type)) return [];

      const windowLabel = `${formatMinSec(startMin)}–${formatMinSec(endMin)}`;
      if (needsChunking) {
        _analysisProgress.set(type, { currentMin: startMin, totalMin: durationSec / 60 });
        notifyAnalysis();
      }

      const prompt = needsChunking
        ? basePrompt + `\n\nStart numbering from ${shotCounter + 1}.\n`
        : basePrompt;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-non-null-assertion
      const videoPart: any = {
        fileData: { fileUri: project.videoFile!.geminiFileUri, mimeType: project.videoFile!.type },
      };
      if (needsChunking) {
        videoPart.videoMetadata = {
          startOffset: `${Math.floor(startMin * 60)}s`,
          endOffset: `${Math.floor(endMin * 60)}s`,
        };
      }

      let finishReason: string | undefined;
      let responseText = "";
      try {
        const result = await ai.models.generateContent({
          model: "gemini-2.5-flash",
          contents: [{ role: "user", parts: [videoPart, { text: prompt }] }],
          config: {
            temperature: 0.1,
            maxOutputTokens: 32768,
            responseMimeType: "application/json",
            thinkingConfig: { thinkingBudget: 0 },
            mediaResolution: MediaResolution.MEDIA_RESOLUTION_LOW,
            abortSignal: abortController.signal,
          },
        });
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        finishReason = (result as any).candidates?.[0]?.finishReason;
        responseText = result.text ?? "";
        console.log(`[analyze] Window ${windowLabel}: ${elapsed}s, ${responseText.length} chars, finishReason=${finishReason}`);
      } catch (apiErr) {
        if (abortController.signal.aborted) return [];
        throw apiErr;
      }

      // MAX_TOKENS with empty body — split and retry before giving up
      if (!responseText.trim()) {
        if (finishReason === "MAX_TOKENS" && depth < 2) {
          console.warn(`[analyze] Empty MAX_TOKENS response for ${windowLabel} — splitting and retrying`);
          const mid = (startMin + endMin) / 2;
          const left = await processWindow(startMin, mid, depth + 1);
          const right = await processWindow(mid, endMin, depth + 1);
          return [...left, ...right];
        }
        console.warn(`[analyze] Empty response for ${windowLabel} (finishReason=${finishReason}), skipping`);
        return [];
      }

      // Synopses is a single object, not an array — handle separately
      if (type === "synopses") {
        const parsed = parseJsonResponse(responseText);
        _store.updateDeliverables({ synopses: parsed });
        return [];
      }

      // Detect hallucination loops in raw text before parsing.
      // If a 60-char window repeats 4+ times consecutively, Gemini is stuck — truncate there.
      responseText = truncateHallucinationLoop(responseText);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let rawEntries: any[];
      try {
        const parsed = parseJsonResponse(responseText);
        rawEntries = parsed.shots || parsed.entries || parsed.bios || [];
      } catch (parseErr) {
        // Truncated JSON from MAX_TOKENS — split and retry to recover the missing portion
        if (finishReason === "MAX_TOKENS" && depth < 2) {
          console.warn(`[analyze] Parse failed after MAX_TOKENS for ${windowLabel} — splitting and retrying`);
          const mid = (startMin + endMin) / 2;
          const left = await processWindow(startMin, mid, depth + 1);
          const right = await processWindow(mid, endMin, depth + 1);
          return [...left, ...right];
        }
        console.error(`[analyze] Parse failed for ${windowLabel} (unrecoverable):`, parseErr);
        return [];
      }

      // Shift timecodes from chunk-relative to absolute.
      // Option A: detect if Gemini returned already-absolute TCs (relative to original file,
      // not the clipped segment). If the first entry's TC is already >= chunkStart, skip shift.
      const chunkOffsetSec = needsChunking ? Math.floor(startMin * 60) : 0;
      let effectiveOffset = chunkOffsetSec;
      if (chunkOffsetSec > 0 && rawEntries.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const firstEntry = rawEntries[0] as any;
        const sampleTc: unknown = firstEntry.tcIn ?? firstEntry.firstAppearance;
        if (typeof sampleTc === "string") {
          const sampleSec = tcToSec(sampleTc);
          if (sampleSec >= startMin * 60) {
            console.log(`[analyze] ${windowLabel}: Gemini returned absolute TCs (sample="${sampleTc}", chunkStart=${startMin}min). Skipping shift.`);
            effectiveOffset = 0;
          } else {
            console.log(`[analyze] ${windowLabel}: TC sample="${sampleTc}" (${sampleSec}s) is chunk-relative. Shifting by +${chunkOffsetSec}s.`);
          }
        }
      }
      const tcFields = ["tcIn", "tcOut", "firstAppearance"] as const;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return effectiveOffset === 0 ? rawEntries : rawEntries.map((e: any) => {
        const r = { ...e };
        for (const key of tcFields) {
          if (typeof r[key] === "string") r[key] = shiftTc(r[key], effectiveOffset, frameRate, dropFrame);
        }
        if (Array.isArray(r.appearances)) {
          r.appearances = r.appearances.map((tc: unknown) =>
            typeof tc === "string" ? shiftTc(tc, effectiveOffset, frameRate, dropFrame) : tc
          );
        }
        return r;
      });
    };

    for (let i = 0; i < chunks.length; i++) {
      if (_cancelFlags.get(type)) {
        console.log(`[analyze] ${type} cancelled by user after chunk ${i}/${chunks.length}`);
        break;
      }

      const chunk = chunks[i];
      console.log(`[analyze] Starting ${type} chunk ${i + 1}/${chunks.length}: ${formatMinSec(chunk.startMin)}–${formatMinSec(chunk.endMin)}`);

      try {
        const entries = await processWindow(chunk.startMin, chunk.endMin, 0);
        allEntries.push(...entries);
        shotCounter = allEntries.length;

        if (needsChunking && entries.length > 0) {
          applyResults(type, allEntries, null, frameRate, dropFrame);
          console.log(`[analyze] Updated UI with ${allEntries.length} entries so far`);
        }
      } catch (chunkErr) {
        if (abortController.signal.aborted) {
          console.log(`[analyze] ${type} chunk ${i + 1} aborted by user`);
          break;
        }
        console.error(`[analyze] Chunk ${i + 1}/${chunks.length} failed (skipping):`, chunkErr);
      }
    }

    // Deduplicate entries at chunk boundaries — Gemini may include a shot at
    // the exact boundary timestamp in BOTH adjacent chunks.
    if (needsChunking && allEntries.length > 0) {
      const before = allEntries.length;
      const seen = new Set<string>();
      const deduped: typeof allEntries = [];
      for (const e of allEntries) {
        const key = `${e.tcIn || ""}|${e.tcOut || ""}`;
        if (!seen.has(key)) { seen.add(key); deduped.push(e); }
      }
      if (deduped.length < before) {
        console.log(`[analyze] Deduped ${before - deduped.length} overlapping entries at chunk boundaries (${before} → ${deduped.length})`);
        allEntries.length = 0;
        allEntries.push(...deduped);
      }
    }

    // For fauna, keep only the first appearance of each species regardless of chunking.
    // The AI re-identifies species in every chunk, so duplicates always occur across chunks.
    if (type === "fauna_log" && allEntries.length > 0) {
      const before = allEntries.length;
      const seenSpecies = new Set<string>();
      const deduped: typeof allEntries = [];
      for (const e of allEntries) {
        const speciesKey = (e.scientificName || e.commonName || "").toLowerCase().trim();
        if (!seenSpecies.has(speciesKey)) {
          seenSpecies.add(speciesKey);
          deduped.push(e);
        }
      }
      if (deduped.length < before) {
        console.log(`[analyze] Fauna: reduced ${before} sightings to ${deduped.length} unique species`);
        allEntries.length = 0;
        allEntries.push(...deduped);
      }
    }

    // For fauna, filter low-confidence entries and cap species density per time window.
    // Addresses hallucinated clusters (e.g. 8 species in 25 seconds) and wrong identifications.
    if (type === "fauna_log" && allEntries.length > 0) {
      const CONFIDENCE_FLOOR = 0.85;
      const beforeConf = allEntries.length;
      const confFiltered = allEntries.filter((e) => parseConfidence(e.confidence) >= CONFIDENCE_FLOOR);
      if (confFiltered.length < beforeConf) {
        console.log(`[analyze] Fauna: removed ${beforeConf - confFiltered.length} entries below ${CONFIDENCE_FLOOR * 100}% confidence (${beforeConf} → ${confFiltered.length})`);
        allEntries.length = 0;
        allEntries.push(...confFiltered);
      }

      // Density cap: max 4 species per 60-second window. Keeps highest-confidence entries.
      const MAX_PER_WINDOW = 4;
      const WINDOW_SEC = 60;
      const buckets = new Map<number, typeof allEntries>();
      for (const entry of allEntries) {
        const bucket = Math.floor(tcToSec(entry.tcIn) / WINDOW_SEC);
        if (!buckets.has(bucket)) buckets.set(bucket, []);
        buckets.get(bucket)!.push(entry);
      }
      const densityCapped: typeof allEntries = [];
      let densityRemoved = 0;
      for (const [, bucket] of buckets) {
        if (bucket.length <= MAX_PER_WINDOW) {
          densityCapped.push(...bucket);
        } else {
          const sorted = [...bucket].sort((a, b) => parseConfidence(b.confidence) - parseConfidence(a.confidence));
          densityCapped.push(...sorted.slice(0, MAX_PER_WINDOW));
          densityRemoved += bucket.length - MAX_PER_WINDOW;
        }
      }
      if (densityRemoved > 0) {
        console.log(`[analyze] Fauna: density cap removed ${densityRemoved} entries exceeding ${MAX_PER_WINDOW} species per ${WINDOW_SEC}s window`);
        densityCapped.sort((a, b) => tcToSec(a.tcIn) - tcToSec(b.tcIn));
        allEntries.length = 0;
        allEntries.push(...densityCapped);
      }
    }

    // For shot lists, drop hallucinated micro-cuts shorter than 8 frames.
    if (type === "shot_list" && allEntries.length > 0) {
      const minFrames = 8;
      const before = allEntries.length;
      const filtered = allEntries.filter((e) => {
        const dur = (e.duration || "").replace(/;/g, ":");
        const parts = dur.split(":").map(Number);
        if (parts.length !== 4) return true; // keep if unparseable
        const totalFrames = parts[0] * 3600 * Math.round(frameRate)
          + parts[1] * 60 * Math.round(frameRate)
          + parts[2] * Math.round(frameRate)
          + parts[3];
        return totalFrames >= minFrames;
      });
      if (filtered.length < before) {
        console.log(`[analyze] Shot list: removed ${before - filtered.length} micro-cuts under ${minFrames} frames (${before} → ${filtered.length})`);
        allEntries.length = 0;
        allEntries.push(...filtered);
      }
    }

    // For talent bios: clamp appearances to clip duration, fix invalid TCs,
    // and opportunistically cross-reference lower-thirds from graphics_list.
    if (type === "talent_bios" && allEntries.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const entry of allEntries as any[]) {
        // Clamp and validate the appearances array
        if (Array.isArray(entry.appearances)) {
          entry.appearances = entry.appearances.filter((tc: unknown) =>
            typeof tc === "string" && isValidTc(tc) && tcToSec(tc) <= durationSec
          );
          entry.appearances.sort((a: string, b: string) => tcToSec(a) - tcToSec(b));
        } else {
          entry.appearances = [];
        }

        // Clamp / recover firstAppearance
        if (typeof entry.firstAppearance === "string") {
          if (!isValidTc(entry.firstAppearance) || tcToSec(entry.firstAppearance) > durationSec) {
            // Fall back to earliest valid appearance
            entry.firstAppearance = entry.appearances[0] ?? (dropFrame ? "00:00:00;00" : "00:00:00:00");
          }
        }
      }

      // Opportunistic graphics cross-reference: if graphicsList is already populated,
      // use lower-third entries as ground truth to correct firstAppearance.
      const graphicsList = project?.deliverables?.graphicsList ?? [];
      const lowerThirds = graphicsList.filter((g) => g.graphicType === "lower_third");
      if (lowerThirds.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const entry of allEntries as any[]) {
          const nameParts = (entry.name as string || "")
            .toLowerCase()
            .split(/\s+/)
            .filter((p: string) => p.length > 2);
          if (nameParts.length === 0) continue;

          const matching = lowerThirds.filter((lt) =>
            nameParts.some((part: string) => lt.content.toLowerCase().includes(part))
          );
          if (matching.length === 0) continue;

          for (const lt of matching) {
            if (!isValidTc(lt.tcIn) || tcToSec(lt.tcIn) > durationSec) continue;
            // Update firstAppearance if this lower-third fires earlier
            if (tcToSec(lt.tcIn) < tcToSec(entry.firstAppearance)) {
              entry.firstAppearance = lt.tcIn;
            }
            // Merge into appearances if not already present
            if (!entry.appearances.includes(lt.tcIn)) {
              entry.appearances.push(lt.tcIn);
            }
          }
          entry.appearances.sort((a: string, b: string) => tcToSec(a) - tcToSec(b));
        }
        console.log(`[analyze] Bios: cross-referenced ${allEntries.length} bios against ${lowerThirds.length} lower-thirds`);
      }
    }

    const totalElapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const wasCancelled = _cancelFlags.get(type);
    console.log(`[analyze] ${type} ${wasCancelled ? "cancelled" : "complete"}: ${type === "synopses" ? "done" : `${allEntries.length} entries`} in ${totalElapsed}s`);

    // Final apply
    if (type !== "synopses") {
      applyResults(type, allEntries, null, frameRate, dropFrame);
    }
  } catch (err) {
    console.error("[analyze] Error:", err);
    _analysisErrors.set(type, err instanceof Error ? err.message : "Analysis failed");
  } finally {
    _analyzing.set(type, false);
    _cancelFlags.delete(type);
    _abortControllers.delete(type);
    _analysisProgress.delete(type);
    notifyAnalysis();
  }
}

/** Parse a confidence value to a 0–1 float. Handles both 0.95 and "95%" formats. */
function parseConfidence(conf: unknown): number {
  if (typeof conf === "number") return conf > 1 ? conf / 100 : conf;
  if (typeof conf === "string") {
    const n = parseFloat(conf.replace("%", "").trim());
    if (!isNaN(n)) return n > 1 ? n / 100 : n;
  }
  return 0;
}

/** Return true if a TC string has valid minute and second fields (< 60). */
function isValidTc(tc: string): boolean {
  const parts = tc.replace(/[;]/g, ":").split(":").map(Number);
  if (parts.length !== 4) return false;
  const [, m, s] = parts;
  return !isNaN(m) && !isNaN(s) && m < 60 && s < 60;
}

/**
 * Shift a timecode string (3- or 4-part) by offsetSec seconds.
 * Normalises 3-part strings (MM:SS:FF) to 4-part before shifting.
 * Uses integer frame arithmetic to avoid floating-point rounding errors.
 */
/**
 * Detect and truncate hallucination loops in raw Gemini JSON text.
 * If the same 60-char window appears 4 or more times consecutively, the model is stuck.
 * Truncate at the start of the first repeat and close the JSON array cleanly.
 */
function truncateHallucinationLoop(text: string): string {
  const WINDOW = 60;
  const THRESHOLD = 4;
  for (let i = 0; i < text.length - WINDOW * THRESHOLD; i++) {
    const sample = text.slice(i, i + WINDOW);
    // Count how many times this window repeats consecutively starting at i
    let repeats = 1;
    let pos = i + WINDOW;
    while (pos + WINDOW <= text.length && text.slice(pos, pos + WINDOW) === sample) {
      repeats++;
      pos += WINDOW;
      if (repeats >= THRESHOLD) break;
    }
    if (repeats >= THRESHOLD) {
      // Truncate at the start of the first repeat
      const truncated = text.slice(0, i);
      // Find last complete JSON entry boundary (closing brace before truncation point)
      const lastClose = truncated.lastIndexOf("}");
      const clean = lastClose >= 0 ? truncated.slice(0, lastClose + 1) + "\n  ]\n}" : text;
      console.warn(`[analyze] Loop detected at char ${i} (sample="${sample.slice(0, 30)}…"), truncating response`);
      return clean;
    }
  }
  return text;
}

/** Parse a TC string to whole seconds (ignores frames). Returns 0 for unrecognised input. */
function tcToSec(tc: string): number {
  const parts = tc.replace(/[;]/g, ":").split(":").map(Number);
  if (parts.length === 4) {
    const [h, m, s] = parts;
    return h * 3600 + m * 60 + s;
  }
  if (parts.length === 3) {
    // Mirror shiftTc heuristic: MM:SS:FF when all < 60, else HH:MM:SS
    if (parts[0] < 60 && parts[1] < 60 && parts[2] < 60) {
      return parts[0] * 60 + parts[1]; // MM:SS — ignore frames
    }
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return 0;
}

function shiftTc(tc: string, offsetSec: number, fps: number, dropFrame: boolean): string {
  if (offsetSec === 0 || typeof tc !== "string") return tc;
  const sep = dropFrame ? ";" : ":";
  const nomFps = Math.round(fps);
  const parts = tc.replace(/[;]/g, ":").split(":").map(Number);
  let h = 0, m = 0, s = 0, f = 0;
  if (parts.length === 4) {
    [h, m, s, f] = parts;
  } else if (parts.length === 3) {
    // Normalise: prefer MM:SS:FF when first two parts are < 60 and frames < 60
    if (parts[0] < 60 && parts[1] < 60 && parts[2] < 60) {
      [m, s, f] = parts;
    } else {
      [h, m, s] = parts;
    }
  } else {
    return tc; // unrecognised format — leave unchanged
  }
  const baseFrames = ((h * 3600 + m * 60 + s) * nomFps) + f;
  const totalFrames = baseFrames + Math.round(offsetSec * nomFps);
  const ff = totalFrames % nomFps;
  const ts = Math.floor(totalFrames / nomFps);
  const ss = ts % 60;
  const tm = Math.floor(ts / 60);
  const mm = tm % 60;
  const hh = Math.floor(tm / 60);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(hh)}:${p(mm)}:${p(ss)}${sep}${p(ff)}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyResults(type: AnalysisType, entries: any[], directParsed: any, frameRate: FrameRate, dropFrame: boolean) {
  const normalizeTimecode = (tc: unknown): string => {
    if (typeof tc !== "string") return dropFrame ? "00:00:00;00" : "00:00:00:00";
    const sep = dropFrame ? ";" : ":";
    const cleaned = tc.replace(/[;]/g, ":");
    const parts = cleaned.split(":");
    if (parts.length === 4) {
      // Zero the frame component — Gemini cannot detect frame-accurate cut points.
      // It outputs artificial fixed offsets (:08, :16, :24) that are meaningless.
      // Showing :00 is cleaner and more honest than a spurious frame number.
      return `${parts[0].padStart(2,"0")}:${parts[1].padStart(2,"0")}:${parts[2].padStart(2,"0")}${sep}00`;
    }
    if (parts.length === 3) {
      const first = parseInt(parts[0], 10);
      const second = parseInt(parts[1], 10);
      const third = parseInt(parts[2], 10);
      // Prefer MM:SS:FF when first two parts are valid minute/second values.
      // Use < 60 for frames (not < fps) because AI sometimes outputs frame=fps at
      // second boundaries (e.g. frame 24 at 24fps) instead of rolling over.
      if (first < 60 && second < 60 && third < 60) {
        return `00:${parts[0].padStart(2, "0")}:${parts[1].padStart(2, "0")}${sep}${parts[2].padStart(2, "0")}`;
      }
      return `${parts[0].padStart(2, "0")}:${parts[1].padStart(2, "0")}:${parts[2].padStart(2, "0")}${sep}00`;
    }
    return dropFrame ? "00:00:00;00" : "00:00:00:00";
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const normalizeEntry = (e: any) => {
    const r = { ...e };
    for (const key of ["tcIn", "tcOut", "duration", "firstAppearance"]) {
      if (key in r) r[key] = normalizeTimecode(r[key]);
    }
    if (Array.isArray(r.appearances)) {
      r.appearances = r.appearances.map((tc: unknown) => normalizeTimecode(tc));
    }
    return r;
  };

  // Strip consecutive hallucinated repetitions — Gemini fills its token budget with identical
  // 5-second shots when it runs out of real content. Detect runs of 3+ entries with the same
  // description and collapse them to a single entry.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dedupeRepetitions = (items: any[]): any[] => {
    const result: any[] = [];
    for (const item of items) {
      // Covers all chunked modules: shot_list (description), dialogue_list (dialogue),
      // graphics_list (content), fauna_log (commonName)
      const desc = (item.description || item.content || item.dialogue || item.commonName || "").trim().toLowerCase();
      const last = result[result.length - 1];
      const secondLast = result[result.length - 2];
      const getDesc = (e: any) => (e.description || e.content || e.dialogue || e.commonName || "").trim().toLowerCase();
      // If the last two entries already have the same description as this one, skip it
      if (
        desc &&
        last && getDesc(last) === desc &&
        secondLast && getDesc(secondLast) === desc
      ) {
        console.warn(`[analyze] Removing hallucinated repetition: "${desc.slice(0, 60)}…"`);
        continue;
      }
      result.push(item);
    }
    return result;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const addIds = (items: any[]) => {
    const deduped = dedupeRepetitions(items);
    if (deduped.length < items.length) {
      console.warn(`[analyze] Removed ${items.length - deduped.length} repetitive hallucinated entries`);
    }
    return deduped.map((e, i) => ({ ...normalizeEntry(e), id: crypto.randomUUID(), shotNumber: i + 1 }));
  };

  switch (type) {
    case "shot_list":
      _store.updateDeliverables({ shotList: addIds(entries) });
      break;
    case "dialogue_list":
      _store.updateDeliverables({ dialogueList: addIds(entries) });
      break;
    case "graphics_list":
      _store.updateDeliverables({ graphicsList: addIds(entries) });
      break;
    case "synopses":
      _store.updateDeliverables({ synopses: directParsed });
      break;
    case "talent_bios":
      _store.updateDeliverables({ talentBios: addIds(entries) });
      break;
    case "fauna_log":
      _store.updateDeliverables({ faunaLog: addIds(entries) });
      break;
  }
}

// ─── Upload state (survives navigation) ─────────────────────────
export interface UploadState {
  status: "idle" | "uploading" | "processing" | "done" | "error";
  progress: number;
  error: string | null;
}

let _uploadState: UploadState = { status: "idle", progress: 0, error: null };
const _uploadListeners = new Set<Listener>();

function notifyUpload() {
  _uploadListeners.forEach((l) => l());
}

export function getUploadState(): UploadState {
  return _uploadState;
}

export function subscribeUpload(listener: Listener) {
  _uploadListeners.add(listener);
  return () => _uploadListeners.delete(listener);
}

export function resetUploadState() {
  _uploadState = { status: "idle", progress: 0, error: null };
  notifyUpload();
}

export async function runUpload(file: File, onDone?: () => void) {
  const state = _store.getState();
  const project = state.project;
  const apiKey = state.apiKey;
  if (!project || !apiKey) return;
  if (_uploadState.status === "uploading" || _uploadState.status === "processing") return;

  _uploadState = { status: "uploading", progress: 0, error: null };
  notifyUpload();

  // Fake progress ticker — SDK doesn't expose upload progress events.
  // 2s per 1% reaches 80% in ~160s, adequate for most file sizes on typical broadband.
  let fakeProgress = 0;
  const progressInterval = setInterval(() => {
    if (fakeProgress < 80 && _uploadState.status === "uploading") {
      fakeProgress++;
      _uploadState = { status: "uploading", progress: fakeProgress, error: null };
      notifyUpload();
    }
  }, 2000);

  try {
    const mimeType = file.type || "video/mp4";

    // Step 0: Extract video duration using browser <video> element
    let videoDuration: number | null = null;
    try {
      videoDuration = await new Promise<number>((resolve, reject) => {
        const video = document.createElement("video");
        video.preload = "metadata";
        video.onloadedmetadata = () => {
          resolve(video.duration);
          URL.revokeObjectURL(video.src);
        };
        video.onerror = () => {
          reject(new Error("Could not read video metadata"));
          URL.revokeObjectURL(video.src);
        };
        video.src = URL.createObjectURL(file);
      });
      console.log(`[upload] Video duration: ${videoDuration?.toFixed(1)}s (${((videoDuration || 0) / 60).toFixed(1)} min)`);
    } catch (e) {
      console.warn("[upload] Could not detect video duration:", e);
    }

    // Step 1: Upload directly to Gemini Files API from the browser.
    // This replaces the GCS + server-side register-file streaming approach,
    // eliminating all Vercel function timeout risk for any deployment environment.
    const { GoogleGenAI } = await import("@google/genai");
    const ai = new GoogleGenAI({ apiKey });

    console.log(`[upload] Uploading ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB) directly to Gemini Files API...`);

    const uploadedFile = await ai.files.upload({
      file,
      config: { mimeType, displayName: file.name },
    });

    clearInterval(progressInterval);
    _uploadState = { status: "processing", progress: 88, error: null };
    notifyUpload();

    console.log(`[upload] Upload complete. File: ${uploadedFile.name}, state: ${uploadedFile.state}, uri: ${uploadedFile.uri}`);

    // Step 2: Poll until ACTIVE (Gemini processes the video server-side — runs entirely client-side)
    let geminiFile = uploadedFile;
    let attempts = 0;
    while (geminiFile.state === "PROCESSING" && attempts < 120) {
      await new Promise((r) => setTimeout(r, 3000));
      geminiFile = await ai.files.get({ name: geminiFile.name! });
      attempts++;
      _uploadState = {
        status: "processing",
        progress: Math.min(88 + Math.round(attempts * 0.5), 99),
        error: null,
      };
      notifyUpload();
      console.log(`[upload] File state: ${geminiFile.state} (attempt ${attempts})`);
    }

    if (geminiFile.state === "FAILED") throw new Error("Gemini failed to process the video");
    if (geminiFile.state === "PROCESSING") throw new Error("Timeout waiting for video processing");

    _uploadState = { status: "done", progress: 100, error: null };
    notifyUpload();

    // New upload — wipe any previous analysis so stale results are never shown
    _store.updateProject({
      videoFile: {
        name: file.name,
        size: file.size,
        type: mimeType,
        duration: videoDuration,
        frameRate: project.settings.frameRate,
        uploadedAt: new Date().toISOString(),
        geminiFileUri: geminiFile.uri!,
      },
      status: "completed",
      deliverables: {
        shotList: [],
        dialogueList: [],
        graphicsList: [],
        synopses: null,
        talentBios: [],
        faunaLog: [],
      },
    });

    onDone?.();
  } catch (err) {
    clearInterval(progressInterval);
    _uploadState = { status: "error", progress: 0, error: err instanceof Error ? err.message : "Upload failed" };
    notifyUpload();
  }
}

// React hook — useState/useEffect pattern to avoid useSyncExternalStore pitfalls in React 19 production
import { useState, useEffect, useRef } from "react";

type StoreState = { project: Project | null; jobs: AnalysisJob[]; apiKey: string; videoBlobUrl: string | null };

export function useStore<T>(selector: (state: StoreState) => T): T {
  const selectorRef = useRef(selector);
  selectorRef.current = selector;

  const [value, setValue] = useState<T>(() => selectorRef.current(_store.getState()));

  useEffect(() => {
    setValue(selectorRef.current(_store.getState()));
    return _store.subscribe(() => {
      setValue(selectorRef.current(_store.getState()));
    });
  }, []);

  return value;
}

// Helper to create empty project
export function createEmptyProject(name: string): Project {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name,
    description: "",
    createdAt: now,
    updatedAt: now,
    videoFile: null,
    settings: {
      frameRate: 25,
      dropFrame: false,
      broadcaster: "PBS",
      language: "auto",
    },
    status: "idle",
    deliverables: {
      shotList: [],
      dialogueList: [],
      graphicsList: [],
      synopses: null,
      talentBios: [],
      faunaLog: [],
    },
  };
}
