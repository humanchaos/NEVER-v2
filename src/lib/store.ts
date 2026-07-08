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
  SHOT_DESCRIBE_PROMPT,
} from "./prompts";
import { secondsToTimecode, subtractTimecodes, timecodeToSeconds } from "./timecode";
import { detectScenes } from "./sceneDetect";
import { edlTcToFrames, type EdlEvent } from "./edl";
import { resolveSource } from "./source";

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

  // localStorage persistence for project + jobs. The API key has its own slot
  // (legacy). videoBlobUrl is NEVER persisted — Blob URLs are scoped to the
  // document; on hydrate we recreate it from the IndexedDB blob cache.
  // Quotas: localStorage caps at ~5–10 MB per origin; a project record is
  // typically <100 KB (no media payload, just metadata + JSON deliverables),
  // so we're nowhere near the limit even for large shot lists.
  function persistProjectAndJobs() {
    if (typeof window === "undefined") return;
    try {
      if (state.project) {
        localStorage.setItem("fdm_project", JSON.stringify(state.project));
      } else {
        localStorage.removeItem("fdm_project");
      }
      localStorage.setItem("fdm_jobs", JSON.stringify(state.jobs));
    } catch (e) {
      // Quota exceeded or storage disabled — non-fatal, project still works in
      // this session. Surface to console so it's debuggable.
      console.warn("[store] Could not persist project/jobs to localStorage:", e);
    }
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
      persistProjectAndJobs();
      notify();
    },

    updateProject(updates: Partial<Project>) {
      if (!state.project) return;
      state = { ...state, project: { ...state.project, ...updates, updatedAt: new Date().toISOString() } };
      persistProjectAndJobs();
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
      persistProjectAndJobs();
      notify();
    },

    setProjectStatus(status: ProjectStatus) {
      if (!state.project) return;
      state = { ...state, project: { ...state.project, status, updatedAt: new Date().toISOString() } };
      persistProjectAndJobs();
      notify();
    },

    setJobs(jobs: AnalysisJob[]) {
      state = { ...state, jobs };
      persistProjectAndJobs();
      notify();
    },

    updateJob(jobId: string, updates: Partial<AnalysisJob>) {
      state = {
        ...state,
        jobs: state.jobs.map((j) => (j.id === jobId ? { ...j, ...updates } : j)),
      };
      persistProjectAndJobs();
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

  // Restore the project + jobs from localStorage. This MUST run before the
  // blob restore below, because that lookup keys off `project.videoFile.geminiFileUri`.
  // Use silent state assignment (not the setters) to avoid persisting back what
  // we just read, and to suppress an early notify before listeners are wired.
  try {
    const savedProject = localStorage.getItem("fdm_project");
    if (savedProject) {
      const proj = JSON.parse(savedProject) as Project;
      _store.setProject(proj);
      console.log(`[hydrate] Restored project "${proj.name}" from localStorage`);
    }
    const savedJobs = localStorage.getItem("fdm_jobs");
    if (savedJobs) {
      const jobs = JSON.parse(savedJobs) as AnalysisJob[];
      if (Array.isArray(jobs)) _store.setJobs(jobs);
    }
  } catch (e) {
    console.warn("[hydrate] Could not parse persisted project/jobs:", e);
  }

  // Restore the video blob from IndexedDB if a project with a Gemini URI is
  // already in the store. This lets a page refresh skip the multi-minute
  // Gemini Files API re-upload — we have the file locally AND the URI is
  // typically still valid for 48h on Gemini's side. The blob URL is
  // re-created from the stored bytes; the URI in the project record is
  // re-used as-is by the analysis pipeline. Runs async to avoid blocking
  // initial render.
  const proj = _store.getState().project;
  const uri = proj?.videoFile?.geminiFileUri;
  if (uri && !_store.getState().videoBlobUrl) {
    (async () => {
      try {
        const { loadVideoBlob } = await import("./blobStore");
        const blob = await loadVideoBlob(uri);
        if (blob) {
          _store.setVideoBlobUrl(URL.createObjectURL(blob));
          console.log(`[hydrate] Restored ${(blob.size/1024/1024).toFixed(1)}MB video blob from IndexedDB — no re-upload needed`);
        } else {
          console.log("[hydrate] No cached blob found for current project URI — re-upload will be required to run two-pass detection");
        }
      } catch (e) {
        console.warn("[hydrate] Blob restore failed:", e);
      }
    })();
  }
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
    case "dialogue_list": return DIALOGUE_LIST_PROMPT(frameRate, dropFrame, language, clipEndTC);
    case "graphics_list": return GRAPHICS_LIST_PROMPT(frameRate, dropFrame, language);
    case "synopses": return SYNOPSES_PROMPT(language);
    case "talent_bios": return TALENT_BIOS_PROMPT(frameRate, dropFrame, language, clipEndTC);
    case "fauna_log": return FAUNA_LOG_PROMPT(frameRate, dropFrame, language, clipEndTC);
  }
}

// Types that produce many entries per minute and need chunking for long videos
const CHUNKED_TYPES: AnalysisType[] = ["shot_list", "dialogue_list", "graphics_list", "fauna_log", "talent_bios"];
// Chunk size in minutes — 5 min prevents MAX_TOKENS hallucination on dense documentary footage.
// At 10 min, Gemini fills the tail of its output budget with repetitive identical shots.
const CHUNK_MINUTES = 5;
// Seconds each chunk extends into the next chunk's territory.
// Ensures shots crossing a 5-min seam are fully visible in at least one chunk.
const OVERLAP_SEC = 20;
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
/** Reset a deliverable to empty so its tab counter resets at the START of a run. */
function clearDeliverable(type: AnalysisType) {
  switch (type) {
    case "shot_list": _store.updateDeliverables({ shotList: [] }); break;
    case "dialogue_list": _store.updateDeliverables({ dialogueList: [] }); break;
    case "graphics_list": _store.updateDeliverables({ graphicsList: [] }); break;
    case "synopses": _store.updateDeliverables({ synopses: null }); break;
    case "talent_bios": _store.updateDeliverables({ talentBios: [] }); break;
    case "fauna_log": _store.updateDeliverables({ faunaLog: [] }); break;
  }
}

export async function runAnalysis(type: AnalysisType) {
  const state = _store.getState();
  const project = state.project;
  const apiKey = state.apiKey;

  // Graphics: when an EDL is attached, use the hybrid EDL+OCR path — the EDL
  // carries the CGI/title graphic clips with frame-exact timing.
  if (type === "graphics_list" && project?.edl && Array.isArray(project.edl.events) && project.edl.events.length > 0) {
    return runGraphicsFromEdl();
  }

  if (!project?.videoFile?.geminiFileUri || !apiKey) return;
  if (_analyzing.get(type)) return; // already running

  _analyzing.set(type, true);
  _analysisErrors.set(type, "");
  _analysisProgress.delete(type);
  clearDeliverable(type); // reset counter/results at the start of each run
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
        chunks.push({ startMin: start, endMin: Math.min(start + CHUNK_MINUTES + OVERLAP_SEC / 60, totalMin) });
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
            // Fauna needs detail: species ID from brief montage shots, small animals
            // (bats, insects, krill) and partial views (a sloth arm, tiger flank) fails
            // at LOW resolution (64 tok/frame). Default res on a 5-min chunk is ~77k
            // input tokens — well within budget, and recall measurably improves.
            ...(type === "fauna_log" ? {} : { mediaResolution: MediaResolution.MEDIA_RESOLUTION_LOW }),
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
        let parsed = parseJsonResponse(responseText);
        // The long synopsis is the last + longest field; under concurrent load it
        // sometimes comes back empty/truncated. Retry once if so.
        if (!String(parsed?.longSynopsis ?? "").trim() && !abortController.signal.aborted) {
          console.warn("[analyze] Synopses long synopsis empty — retrying once");
          try {
            const retry = await ai.models.generateContent({
              model: "gemini-2.5-flash",
              contents: [{ role: "user", parts: [videoPart, { text: prompt }] }],
              config: {
                temperature: 0.2, maxOutputTokens: 32768, responseMimeType: "application/json",
                thinkingConfig: { thinkingBudget: 0 }, mediaResolution: MediaResolution.MEDIA_RESOLUTION_LOW,
                abortSignal: abortController.signal,
              },
            });
            const reparsed = parseJsonResponse(retry.text ?? "");
            if (String(reparsed?.longSynopsis ?? "").trim()) parsed = reparsed;
          } catch { /* keep first parse */ }
        }
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
      // Majority vote across ALL entries (not just the first): under which interpretation —
      // chunk-relative [0, windowLen] vs already-absolute [chunkStart, chunkEnd] — do more
      // entries land inside the chunk's window? A single-sample heuristic mislabels whole
      // chunks when the first entry is an outlier, which collapses every TC in the chunk.
      const chunkOffsetSec = needsChunking ? Math.floor(startMin * 60) : 0;
      const windowLenSec = (endMin - startMin) * 60;
      let effectiveOffset = chunkOffsetSec;
      if (chunkOffsetSec > 0 && rawEntries.length > 0) {
        let relVotes = 0;
        let absVotes = 0;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const e of rawEntries as any[]) {
          const tc: unknown = e.tcIn ?? e.firstAppearance;
          if (typeof tc !== "string") continue;
          const s = tcToSec(tc, frameRate);
          if (s >= 0 && s <= windowLenSec + 5) relVotes++;
          if (s >= chunkOffsetSec - 5 && s <= chunkOffsetSec + windowLenSec + 5) absVotes++;
        }
        if (absVotes > relVotes) {
          console.log(`[analyze] ${windowLabel}: TCs vote absolute (${absVotes} abs vs ${relVotes} rel). Skipping shift.`);
          effectiveOffset = 0;
        } else {
          console.log(`[analyze] ${windowLabel}: TCs vote chunk-relative (${relVotes} rel vs ${absVotes} abs). Shifting by +${chunkOffsetSec}s.`);
        }
      }
      const tcFields = ["tcIn", "tcOut", "firstAppearance"] as const;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const shifted = effectiveOffset === 0 ? rawEntries : rawEntries.map((e: any) => {
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
      // Hard validation: after absolutisation every entry must land inside this chunk's
      // window (± tolerance). Entries outside are hallucinated TCs — dropping them here is
      // what keeps one bad chunk from poisoning the merged result.
      if (!needsChunking) return shifted;
      const loSec = chunkOffsetSec - 5;
      const hiSec = chunkOffsetSec + windowLenSec + 5;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const inWindow = shifted.filter((e: any) => {
        const tc: unknown = e.tcIn ?? e.firstAppearance;
        if (typeof tc !== "string") return true; // no TC to judge — keep
        const s = tcToSec(tc, frameRate);
        return s >= loSec && s <= hiSec && s <= durationSec + 2;
      });
      if (inWindow.length < shifted.length) {
        console.warn(`[analyze] ${windowLabel}: dropped ${shifted.length - inWindow.length} entries with out-of-window TCs (hallucinated)`);
      }
      return inWindow;
    };

    let failedChunks = 0;
    let lastChunkError: unknown = null;
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
        failedChunks++;
        lastChunkError = chunkErr;
        console.error(`[analyze] Chunk ${i + 1}/${chunks.length} failed (skipping):`, chunkErr);
      }
    }

    // Surface systemic failures instead of silently applying a sparse/empty result.
    // The classic case: the Gemini file expired (403 PERMISSION_DENIED) and every chunk
    // fails — previously this completed "successfully" with 0 entries.
    if (failedChunks === chunks.length && chunks.length > 0 && !_cancelFlags.get(type) && !abortController.signal.aborted) {
      const detail = lastChunkError instanceof Error ? lastChunkError.message : String(lastChunkError ?? "");
      const expired = detail.includes("PERMISSION_DENIED") || detail.includes("403");
      throw new Error(
        expired
          ? "All chunks failed: the uploaded video has expired on Gemini (files are kept 48h). Remove and re-upload the video, then run again."
          : `All ${chunks.length} chunks failed — no results. Last error: ${detail.slice(0, 200)}`
      );
    }
    if (failedChunks > 0) {
      console.warn(`[analyze] ${type}: ${failedChunks}/${chunks.length} chunks failed — results are INCOMPLETE for those time ranges`);
    }

    // Global duration guard: no valid TC can exceed the video duration. Catches fabricated
    // TCs in non-chunked runs and any stragglers the per-chunk window filter missed.
    // tcIn beyond duration → drop the whole entry (it's misplaced). tcOut beyond duration
    // or ≤ tcIn → CLAMP, not drop: the line/sighting is real, only the out-point is bad
    // (e.g. a dialogue line at 10:25:58 came back with tcOut 11:25:00, an hour past end).
    if (durationSec > 0 && allEntries.length > 0) {
      const before = allEntries.length;
      const maxSec = durationSec + 2;
      // Per-type fallback span when an out-point must be synthesized.
      const fallbackSec = type === "dialogue_list" ? 4 : type === "fauna_log" ? 2 : 3;
      let clamped = 0;
      const inBounds = allEntries.filter((e) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ee = e as any;
        const inTcRaw: unknown = ee.tcIn ?? ee.firstAppearance;
        if (typeof inTcRaw !== "string") return true;
        const inSec = tcToSec(inTcRaw);
        if (inSec > maxSec) return false; // tcIn out of range → misplaced, drop
        if (typeof ee.tcOut === "string" && ee.tcOut) {
          const outSec = tcToSec(ee.tcOut);
          if (outSec > maxSec || outSec <= inSec) {
            ee.tcOut = shiftTc(ee.tcIn ?? inTcRaw, fallbackSec, frameRate, dropFrame);
            clamped++;
          }
        }
        return true;
      });
      if (inBounds.length < before || clamped > 0) {
        console.warn(`[analyze] ${type}: dropped ${before - inBounds.length} entries with out-of-range tcIn, clamped ${clamped} bad tcOut (video ${Math.round(durationSec)}s)`);
        allEntries.length = 0;
        allEntries.push(...inBounds);
      }
    }

    // Deduplicate entries at chunk boundaries — Gemini may include a shot at
    // the exact boundary timestamp in BOTH adjacent chunks.
    // Skipped for talent_bios: bios have no tcIn/tcOut, so the composite key would be
    // identical ("|") for every person and collapse the list to one entry. Bios get
    // their own name-based merge below.
    if (needsChunking && type !== "talent_bios" && allEntries.length > 0) {
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

    // Stitch shots split by chunk boundaries.
    // With overlap, chunk N sees a shot fully (e.g. 4:52–5:08) while chunk N+1 may still
    // report the same shot starting at the nominal boundary (5:00). Detect this by checking
    // whether a new entry's tcIn lands within 3s of a nominal boundary AND the previous
    // entry already covers that time. When detected, extend the previous entry's tcOut
    // (if the new entry reaches further) and discard the duplicate.
    if (needsChunking && type !== "talent_bios" && allEntries.length > 0) {
      const BOUNDARY_TOLERANCE_SEC = 3;
      const chunkPeriodSec = CHUNK_MINUTES * 60;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stitched: any[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const e of allEntries) {
        const tcInSec = tcToSec(e.tcIn ?? "");
        const mod = tcInSec % chunkPeriodSec;
        const nearBoundary = mod < BOUNDARY_TOLERANCE_SEC || mod > chunkPeriodSec - BOUNDARY_TOLERANCE_SEC;
        const prev = stitched[stitched.length - 1];
        const prevTcOutSec = prev ? tcToSec(prev.tcOut ?? prev.tcIn ?? "") : -1;
        if (prev && nearBoundary && prevTcOutSec >= tcInSec - BOUNDARY_TOLERANCE_SEC) {
          const currTcOutSec = tcToSec(e.tcOut ?? e.tcIn ?? "");
          if (currTcOutSec > prevTcOutSec) prev.tcOut = e.tcOut;
          console.log(`[analyze] Stitched boundary split at ${e.tcIn} into previous shot (${prev.tcIn}–${prev.tcOut})`);
        } else {
          stitched.push(e);
        }
      }
      if (stitched.length < allEntries.length) {
        console.log(`[analyze] Boundary stitch merged ${allEntries.length - stitched.length} split shots`);
        allEntries.length = 0;
        allEntries.push(...stitched);
      }
    }

    // For dialogue, drop chunk-overlap duplicates: the 20s overlap means lines near a
    // chunk boundary get transcribed by BOTH adjacent chunks, with slightly different
    // TCs (so the exact tcIn|tcOut dedup misses them) and sometimes different speaker
    // labels. Match on normalized TEXT within 30s — but only when the later entry sits
    // in the overlap re-scan zone just after a nominal chunk boundary, so legitimate
    // quick repeats elsewhere (e.g. "Blow!" shouted five times) are never touched.
    if (needsChunking && type === "dialogue_list" && allEntries.length > 0) {
      const chunkPeriodSec = CHUNK_MINUTES * 60;
      const ZONE_SEC = OVERLAP_SEC + 15;
      const normText = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sorted = [...(allEntries as any[])].sort((a, b) => tcToSec(a.tcIn ?? "") - tcToSec(b.tcIn ?? ""));
      const lastByText = new Map<string, number>();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const deduped: any[] = [];
      for (const e of sorted) {
        const key = normText(e.dialogue);
        const sec = tcToSec(e.tcIn ?? "");
        const prevSec = lastByText.get(key);
        const inZone = sec % chunkPeriodSec < ZONE_SEC;
        if (key && prevSec != null && sec - prevSec <= 30 && inZone) continue;
        if (key) lastByText.set(key, sec);
        deduped.push(e);
      }
      if (deduped.length < allEntries.length) {
        console.log(`[analyze] Dialogue: dropped ${allEntries.length - deduped.length} chunk-overlap duplicate lines`);
        allEntries.length = 0;
        allEntries.push(...deduped);
      }
    }

    // For talent bios, merge people across chunks by normalized name, AND drop
    // unnamed/background people. Chunking lifts recall (every real expert is seen) but
    // each chunk also re-describes crew/crowd with a different generic label
    // ("Unidentified Male (Beard)", "Man with hat", "Research Assistant"), so without
    // this filter the list balloons with junk that never merges.
    if (type === "talent_bios" && allEntries.length > 0) {
      const normName = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      // A name is "real" only if it's a proper name we can attribute. Reject generic
      // descriptors and bare role words — those are unnamed background people.
      const GENERIC = /\b(unidentified|unknown|unnamed|man|woman|male|female|boy|girl|person|people|guy|crew|assistant|audience|crowd|bystander|narrator|presenter|host|subject|interviewee|scientist|researcher|volunteer|photographer|ranger|driver|worker|child|kid)\b/i;
      const isRealName = (raw: unknown): boolean => {
        const n = String(raw ?? "").trim();
        if (!n) return false;
        if (GENERIC.test(n)) return false;          // contains a generic descriptor word
        const tokens = n.split(/\s+/).filter(Boolean);
        if (tokens.length < 2) return false;         // require first + last name
        return /^[A-Za-zÀ-ÿ.'-]+$/.test(tokens[0]);  // first token looks like a name, not "(beard)"
      };

      // Authority list of full "First Last" names, drawn from graphics lower-thirds
      // (reliably OCR'd, e.g. "ANDREW DENNIS / WILDLIFE ECOLOGIST") plus the talent
      // entries that already have full names. Used to rescue people the talent pass
      // only caught by first name in their chunk (so "Andrew" → "Andrew Dennis").
      const fullNames = new Set<string>();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const e of allEntries as any[]) if (isRealName(e.name)) fullNames.add(String(e.name).trim());
      const lts = (_store.getState().project?.deliverables?.graphicsList ?? [])
        .filter((g) => g.graphicType === "lower_third");
      for (const lt of lts) {
        const firstLine = String(lt.content || "").split(/[\n/]/)[0].trim();
        const toks = firstLine.split(/\s+/).filter(Boolean);
        if (toks.length === 2 && toks.every((t) => /^[A-Za-zÀ-ÿ.'-]+$/.test(t))) {
          // Title-case so it merges cleanly with model output ("ANDREW DENNIS" → "Andrew Dennis").
          fullNames.add(toks.map((t) => t[0].toUpperCase() + t.slice(1).toLowerCase()).join(" "));
        }
      }
      // Map a bare first name to a full name ONLY if exactly one authority name starts
      // with it. Ambiguous first names (e.g. "Scott" → both Burnett and Carver) are NOT
      // rescued — they stay dropped, so we never misattribute.
      const rescueSingle = (raw: unknown): string | null => {
        const n = String(raw ?? "").trim();
        const tokens = n.split(/\s+/).filter(Boolean);
        if (tokens.length !== 1 || GENERIC.test(n) || !/^[A-Za-zÀ-ÿ.'-]{2,}$/.test(tokens[0])) return null;
        const first = tokens[0].toLowerCase();
        const matches = [...fullNames].filter((fn) => fn.split(/\s+/)[0].toLowerCase() === first);
        return matches.length === 1 ? matches[0] : null;
      };

      const before = allEntries.length;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const named = (allEntries as any[]).filter((e) => {
        if (isRealName(e.name)) return true;
        const rescued = rescueSingle(e.name);
        if (rescued) { e.name = rescued; return true; } // promote in place, then it merges by name
        return false;
      });
      const dropped = before - named.length;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const byName = new Map<string, any>();
      for (const e of named) {
        const key = normName(e.name);
        const existing = byName.get(key);
        if (!existing) {
          byName.set(key, { ...e, appearances: Array.isArray(e.appearances) ? [...e.appearances] : [] });
          continue;
        }
        if (typeof e.firstAppearance === "string" &&
            (typeof existing.firstAppearance !== "string" || tcToSec(e.firstAppearance) < tcToSec(existing.firstAppearance))) {
          existing.firstAppearance = e.firstAppearance;
        }
        if (String(e.bio ?? "").length > String(existing.bio ?? "").length) existing.bio = e.bio;
        if (String(e.role ?? "").length > String(existing.role ?? "").length) existing.role = e.role;
        if (Array.isArray(e.appearances)) existing.appearances.push(...e.appearances);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const merged = [...byName.values()].map((p: any) => {
        const uniq = [...new Set((p.appearances as unknown[]).filter((t) => typeof t === "string"))] as string[];
        uniq.sort((a, b) => tcToSec(a) - tcToSec(b));
        return { ...p, appearances: uniq.slice(0, 10) };
      });
      merged.sort((a, b) => tcToSec(String(a.firstAppearance ?? "")) - tcToSec(String(b.firstAppearance ?? "")));
      console.log(`[analyze] Talent: ${before} sightings → ${merged.length} named people (dropped ${dropped} unnamed/background)`);
      allEntries.length = 0;
      allEntries.push(...merged);
    }

    // For fauna, repair zero/negative-duration sightings (tcOut <= tcIn): extend tcOut
    // to tcIn + 1s. These come from montage shots where the model pins both TCs to the
    // same frame — the sighting is usually real, the duration is not.
    if (type === "fauna_log" && allEntries.length > 0) {
      let repaired = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const e of allEntries as any[]) {
        if (typeof e.tcIn !== "string" || !e.tcIn) continue;
        const inS = tcToSec(e.tcIn);
        const outS = typeof e.tcOut === "string" && e.tcOut ? tcToSec(e.tcOut) : -1;
        if (outS <= inS) {
          e.tcOut = shiftTc(e.tcIn, 1, frameRate, dropFrame);
          repaired++;
        }
      }
      if (repaired) console.log(`[analyze] Fauna: repaired ${repaired} zero-duration sightings (tcOut extended to tcIn + 1s)`);
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
      const CONFIDENCE_FLOOR = 0.8;
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

    // For shot lists, drop zero-length or inverted shots, then micro-cuts under 8 frames.
    if (type === "shot_list" && allEntries.length > 0) {
      const minFrames = 8;
      const before = allEntries.length;
      const filtered = allEntries.filter((e) => {
        // Drop shots where tcOut <= tcIn — Gemini occasionally produces inverted or
        // zero-length entries when it hallucinates a cut at a single frame boundary.
        if (typeof e.tcIn === "string" && typeof e.tcOut === "string") {
          if (tcToSec(e.tcOut) <= tcToSec(e.tcIn)) return false;
        }
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
        console.log(`[analyze] Shot list: removed ${before - filtered.length} invalid/micro shots (${before} → ${filtered.length})`);
        allEntries.length = 0;
        allEntries.push(...filtered);
      }
    }

    // Label normalization: flag English descriptions when German output expected (warn only),
    // and truncate descriptions that exceed 120 characters.
    if (type === "shot_list" && allEntries.length > 0) {
      const MAX_DESC_CHARS = 120;
      const EN_STOPWORDS = [" the ", " and ", " of ", " with "];
      let langViolations = 0;
      let truncations = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const e of allEntries as any[]) {
        const desc: string = e.description || "";
        if (desc.length > MAX_DESC_CHARS) {
          e.description = desc.slice(0, MAX_DESC_CHARS).replace(/[,;]?\s+\S+$/, "").trim();
          truncations++;
        }
        if (
          (project.settings.language === "de" || project.settings.language === "auto") &&
          EN_STOPWORDS.some((w) => desc.includes(w))
        ) {
          langViolations++;
        }
      }
      if (truncations > 0) console.log(`[validate] Shot list: truncated ${truncations} descriptions > ${MAX_DESC_CHARS} chars`);
      if (langViolations > 0) console.warn(`[validate] Shot list: ${langViolations} descriptions contain English stopwords — expected German output`);
    }

    // Validation Test 3: merge shot splits without a visible cut.
    // If the previous shot ran for < 5 s AND the next shot's description shares ≥2 significant
    // words, it is almost certainly a spurious split — extend the previous shot and discard the new one.
    if (type === "shot_list" && allEntries.length > 0) {
      const SPLIT_WINDOW_SEC = 5;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stitchedSplits: any[] = [];
      let splitMerges = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const e of allEntries as any[]) {
        const prev = stitchedSplits[stitchedSplits.length - 1];
        if (prev) {
          const prevDurationSec = tcToSec(e.tcIn) - tcToSec(prev.tcIn);
          if (prevDurationSec < SPLIT_WINDOW_SEC && shotDescriptionsSimilar(prev.description, e.description)) {
            if (tcToSec(e.tcOut) > tcToSec(prev.tcOut)) prev.tcOut = e.tcOut;
            splitMerges++;
            console.log(`[validate] Merged split-without-cut at ${e.tcIn}: "${e.description}"`);
            continue;
          }
        }
        stitchedSplits.push(e);
      }
      if (splitMerges > 0) {
        console.log(`[validate] Shot list: merged ${splitMerges} split-without-cut entries`);
        allEntries.length = 0;
        allEntries.push(...stitchedSplits);
      }
    }

    // Validation Test 4: micro-shot spam — more than 3 shots under 2 s per 60-s window.
    // Indicates compression-artefact detection rather than genuine editorial cuts.
    // Shortest shots are removed first within each offending window.
    if (type === "shot_list" && allEntries.length > 0) {
      const SPAM_WINDOW_SEC = 60;
      const SPAM_SHORT_SEC = 2;
      const SPAM_MAX_PER_WINDOW = 3;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const keepFlags = new Map<any, boolean>(allEntries.map((e) => [e, true]));
      for (let winStart = 0; winStart < durationSec; winStart += SPAM_WINDOW_SEC) {
        const winEnd = winStart + SPAM_WINDOW_SEC;
        const shortInWindow = allEntries.filter(
          (e) =>
            keepFlags.get(e) &&
            tcToSec(e.tcOut) - tcToSec(e.tcIn) < SPAM_SHORT_SEC &&
            tcToSec(e.tcIn) >= winStart &&
            tcToSec(e.tcIn) < winEnd
        );
        if (shortInWindow.length > SPAM_MAX_PER_WINDOW) {
          const sorted = [...shortInWindow].sort(
            (a, b) => (tcToSec(a.tcOut) - tcToSec(a.tcIn)) - (tcToSec(b.tcOut) - tcToSec(b.tcIn))
          );
          for (const e of sorted.slice(0, shortInWindow.length - SPAM_MAX_PER_WINDOW)) {
            keepFlags.set(e, false);
          }
        }
      }
      const beforeSpam = allEntries.length;
      const spamFiltered = allEntries.filter((e) => keepFlags.get(e));
      if (spamFiltered.length < beforeSpam) {
        console.log(`[validate] Shot list: removed ${beforeSpam - spamFiltered.length} micro-shot spam entries (>${SPAM_MAX_PER_WINDOW} sub-${SPAM_SHORT_SEC}s shots per ${SPAM_WINDOW_SEC}s)`);
        allEntries.length = 0;
        allEntries.push(...spamFiltered);
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

/**
 * Two-pass shot list: detect cuts first, then describe each shot from its middle frame.
 *
 * WHY THIS EXISTS:
 * The single-pass `runAnalysis("shot_list")` asks Gemini to detect cuts AND describe
 * each shot in one big call. On dense documentary footage this produces too many
 * shots (vs human Gold) and triggers MAX_TOKENS hallucination loops. Eight
 * post-processing passes (boundary stitch, micro-shot filter, spam filter, etc.)
 * try to clean up the output, but the underlying problem is the prompt is too broad.
 *
 * THIS APPROACH:
 *   Phase 1 — Boundary detection. Ask Gemini for cut timecodes ONLY (no descriptions).
 *             Small output → no token-budget hallucinations. Chunked the same way as
 *             the single-pass flow for long videos.
 *   Phase 2 — Build intervals from cut timecodes + duration.
 *   Phase 3 — Extract the middle frame of each interval via the browser's <video>
 *             + canvas (reuses `extractFrame()` from frames.ts).
 *   Phase 4 — Describe each frame with a per-image Gemini call. Each call sees ONE
 *             still and is asked for description, sceneType, cameraMovement, notes.
 *             Parallel with concurrency cap of 4.
 *
 * The post-processing passes from `runAnalysis()` are DELIBERATELY NOT applied here —
 * if the source output is clean, the bandaids are not needed.
 */
export async function runShotListTwoPass() {
  const state = _store.getState();
  const project = state.project;
  const apiKey = state.apiKey;
  let videoBlobUrl = state.videoBlobUrl;

  // Dispatch: if an EDL is attached, use the frame-EXACT EDL path instead of
  // pixel-based cut detection. The EDL gives gold cuts + source provenance.
  if (project?.edl && Array.isArray(project.edl.events) && project.edl.events.length > 0) {
    return runShotListFromEdl();
  }

  if (!project?.videoFile?.geminiFileUri || !apiKey) return;

  // The local blob URL may not be attached yet if the user clicks Generate
  // immediately after a page load (the IndexedDB restore in hydrateStore() runs
  // async and can take ~1s for a multi-GB file). Rather than fail with a
  // re-upload prompt, try an on-demand restore from the blob cache first.
  if (!videoBlobUrl) {
    try {
      const { loadVideoBlob } = await import("./blobStore");
      const blob = await loadVideoBlob(project.videoFile.geminiFileUri);
      if (blob) {
        const url = URL.createObjectURL(blob);
        _store.setVideoBlobUrl(url);
        videoBlobUrl = url;
        console.log("[two-pass] Restored local video blob on demand from IndexedDB");
      }
    } catch (e) {
      console.warn("[two-pass] On-demand blob restore failed:", e);
    }
  }

  if (!videoBlobUrl) {
    _analysisErrors.set(
      "shot_list",
      "Two-pass needs the local video file, which isn't cached in this browser. Re-upload the file once to enable it (future refreshes won't need re-uploading)."
    );
    notifyAnalysis();
    return;
  }
  if (_analyzing.get("shot_list")) return;

  _analyzing.set("shot_list", true);
  _analysisErrors.set("shot_list", "");
  _analysisProgress.delete("shot_list");
  clearDeliverable("shot_list"); // reset counter at run start
  notifyAnalysis();

  const frameRate = project.settings.frameRate;
  const dropFrame = project.settings.dropFrame;
  const language = project.settings.language;
  const durationSec = project.videoFile.duration || 0;
  const totalMin = durationSec / 60;

  const abortController = new AbortController();
  _abortControllers.set("shot_list", abortController);

  const t0 = Date.now();

  try {
    const { GoogleGenAI } = await import("@google/genai");
    const ai = new GoogleGenAI({ apiKey });

    // ─── Phase 1: Deterministic cut detection (client-side frame diff) ──────
    // Replaces the former Gemini boundary-detection pass. Gemini recovered only
    // ~31% of real cuts (it pattern-completes timecodes rather than "seeing"
    // cuts); a histogram frame-diff scan reaches ~89% recall / ~87% precision.
    // See src/lib/sceneDetect.ts for the validated algorithm and parameters.
    console.log(`[two-pass] Phase 1: scanning video for cuts (frame-diff)`);
    let rawCuts: number[] = [];
    try {
      rawCuts = await detectScenes(videoBlobUrl, {
        frameRate,
        onProgress: (frac) => {
          // Phase 1 occupies the first half of the progress indicator.
          _analysisProgress.set("shot_list", { currentMin: frac * totalMin * 0.5, totalMin });
          notifyAnalysis();
        },
        signal: abortController.signal,
      });
    } catch (err) {
      console.error("[two-pass] Scene detection failed:", err);
      _analysisErrors.set(
        "shot_list",
        err instanceof Error ? `Cut detection failed: ${err.message}` : "Cut detection failed"
      );
      return;
    }

    if (_cancelFlags.get("shot_list") || abortController.signal.aborted) return;

    // Keep only cuts strictly inside the clip, sorted, de-duplicated within 0.5 s.
    const sortedCuts = rawCuts.filter((s) => s > 0 && s < durationSec).sort((a, b) => a - b);
    const MIN_GAP_SEC = 0.5;
    const dedupedCuts: number[] = [];
    for (const cut of sortedCuts) {
      if (dedupedCuts.length === 0 || cut - dedupedCuts[dedupedCuts.length - 1] >= MIN_GAP_SEC) {
        dedupedCuts.push(cut);
      }
    }
    console.log(`[two-pass] Phase 1 done: ${rawCuts.length} raw cuts → ${dedupedCuts.length} deduped`);

    if (_cancelFlags.get("shot_list") || abortController.signal.aborted) return;

    // ─── Phase 2: Build intervals from cuts + duration ──────────────────────
    const boundariesSec = [0, ...dedupedCuts, durationSec];
    const intervals: { tcIn: string; tcOut: string; startSec: number; endSec: number; midpointSec: number; durationTC: string }[] = [];
    for (let i = 0; i < boundariesSec.length - 1; i++) {
      const startSec = boundariesSec[i];
      const endSec = boundariesSec[i + 1];
      if (endSec - startSec < 8 / frameRate) continue; // Skip < 8-frame slivers
      const tcIn = secondsToTimecode(startSec, frameRate, dropFrame);
      const tcOut = secondsToTimecode(endSec, frameRate, dropFrame);
      intervals.push({
        tcIn,
        tcOut,
        startSec,
        endSec,
        midpointSec: (startSec + endSec) / 2,
        durationTC: subtractTimecodes(tcOut, tcIn, frameRate, dropFrame),
      });
    }
    console.log(`[two-pass] Phase 2: built ${intervals.length} shot intervals`);

    if (intervals.length === 0) {
      console.warn("[two-pass] No intervals produced — nothing to describe");
      applyResults("shot_list", [], null, frameRate, dropFrame);
      return;
    }

    // ─── Phase 3: Extract start/middle/end frames for each interval ──────────
    // Three frames per shot let the model see the action unfold (and judge camera
    // movement); a single ambiguous frame is the main source of hallucinated
    // descriptions. Sample points are inset 15% (min 0.2s) from the cuts so that
    // imprecise browser seeking can't land on the adjacent shot. Shots too short
    // for a safe inset fall back to the midpoint alone.
    // extractFrame() has an internal semaphore (MAX_CONCURRENT = 4 in frames.ts).
    const { extractFrame } = await import("./frames");
    const frameDataUrls: string[][] = Array.from({ length: intervals.length }, () => []);

    console.log(`[two-pass] Phase 3: extracting frames for ${intervals.length} shots (semaphore-capped at 4)`);
    let phase3Completed = 0;
    await Promise.allSettled(
      intervals.map(async (iv, idx) => {
        if (_cancelFlags.get("shot_list") || abortController.signal.aborted) return;
        const span = Math.max(0, iv.endSec - iv.startSec);
        const inset = Math.max(0.2, span * 0.15);
        const pts = span < inset * 2.5
          ? [iv.midpointSec]
          : [iv.startSec + inset, iv.midpointSec, iv.endSec - inset];
        try {
          for (const s of pts) {
            const tc = secondsToTimecode(Math.max(0, Math.min(s, durationSec - 0.05)), frameRate, dropFrame);
            const f = await extractFrame(videoBlobUrl, tc, frameRate);
            if (f) frameDataUrls[idx].push(f);
          }
        } catch (err) {
          console.warn(`[two-pass] Frame extraction failed for shot ${idx + 1}:`, err);
        } finally {
          phase3Completed++;
          // Phase 3 progress takes the [50%, 60%] band of the timeline indicator.
          _analysisProgress.set("shot_list", {
            currentMin: totalMin * (0.5 + 0.1 * (phase3Completed / intervals.length)),
            totalMin,
          });
          notifyAnalysis();
        }
      })
    );

    if (_cancelFlags.get("shot_list") || abortController.signal.aborted) return;

    // ─── Phase 4: Describe each frame ─────────────────────────────────────────
    const describePrompt = SHOT_DESCRIBE_PROMPT(language);
    type ShotDesc = { description: string; sceneType: string; cameraMovement: string; notes: string };
    const descriptions: (ShotDesc | null)[] = new Array(intervals.length).fill(null);
    let phase4Completed = 0;

    const describeOne = async (idx: number): Promise<void> => {
      if (_cancelFlags.get("shot_list") || abortController.signal.aborted) return;
      const frames = frameDataUrls[idx];
      if (frames.length === 0) {
        descriptions[idx] = { description: "", sceneType: "", cameraMovement: "Static", notes: "[frame missing]" };
        return;
      }

      try {
        const result = await ai.models.generateContent({
          model: "gemini-2.5-flash",
          contents: [
            {
              role: "user",
              parts: [
                // Strip "data:image/jpeg;base64," prefix from each frame
                ...frames.map((f) => ({ inlineData: { data: f.split(",")[1] ?? "", mimeType: "image/jpeg" } })),
                { text: describePrompt },
              ],
            },
          ],
          config: {
            temperature: 0.1,
            maxOutputTokens: 1024, // Per-shot response is tiny
            responseMimeType: "application/json",
            thinkingConfig: { thinkingBudget: 0 },
            abortSignal: abortController.signal,
          },
        });
        const responseText = result.text ?? "";
        if (!responseText.trim()) {
          descriptions[idx] = { description: "", sceneType: "", cameraMovement: "Static", notes: "" };
          return;
        }
        const parsed = parseJsonResponse(responseText);
        descriptions[idx] = {
          description: typeof parsed.description === "string" ? parsed.description.slice(0, 120) : "",
          sceneType: typeof parsed.sceneType === "string" ? parsed.sceneType : "",
          cameraMovement: typeof parsed.cameraMovement === "string" ? parsed.cameraMovement : "Static",
          notes: typeof parsed.notes === "string" ? parsed.notes : "",
        };
      } catch (err) {
        if (abortController.signal.aborted) return;
        console.warn(`[two-pass] Describe failed for shot ${idx + 1}:`, err);
        descriptions[idx] = { description: "", sceneType: "", cameraMovement: "Static", notes: "[describe failed]" };
      }
    };

    // Concurrency-capped worker pool, mirror of frames.ts MAX_CONCURRENT
    const CONCURRENT = 4;
    console.log(`[two-pass] Phase 4: describing ${intervals.length} shots (concurrency=${CONCURRENT})`);
    let nextIdx = 0;
    const inFlight = new Set<Promise<void>>();
    while (nextIdx < intervals.length || inFlight.size > 0) {
      while (inFlight.size < CONCURRENT && nextIdx < intervals.length) {
        if (_cancelFlags.get("shot_list") || abortController.signal.aborted) break;
        const idx = nextIdx++;
        const p = describeOne(idx).finally(() => {
          inFlight.delete(p);
          phase4Completed++;
          // Phase 4 fills the [60%, 100%] band — linear in completion count to
          // avoid the jitter you'd see if we used the random midpointSec of
          // whichever shot happens to finish next under parallel execution.
          _analysisProgress.set("shot_list", {
            currentMin: totalMin * (0.6 + 0.4 * (phase4Completed / intervals.length)),
            totalMin,
          });
          notifyAnalysis();
        });
        inFlight.add(p);
      }
      if (inFlight.size > 0) await Promise.race(inFlight);
      if (_cancelFlags.get("shot_list") || abortController.signal.aborted) break;
    }
    await Promise.all([...inFlight]); // drain remaining

    // ─── Phase 5: Assemble shot list ─────────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shots: any[] = intervals.map((iv, i) => ({
      shotNumber: i + 1,
      tcIn: iv.tcIn,
      tcOut: iv.tcOut,
      duration: iv.durationTC,
      description: descriptions[i]?.description || "",
      sceneType: descriptions[i]?.sceneType || "",
      cameraMovement: descriptions[i]?.cameraMovement || "Static",
      notes: descriptions[i]?.notes || "",
    }));

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[two-pass] Complete: ${shots.length} shots in ${elapsed}s`);

    applyResults("shot_list", shots, null, frameRate, dropFrame);
  } catch (err) {
    console.error("[two-pass] Error:", err);
    _analysisErrors.set("shot_list", err instanceof Error ? err.message : "Two-pass analysis failed");
  } finally {
    _analyzing.set("shot_list", false);
    _cancelFlags.delete("shot_list");
    _abortControllers.delete("shot_list");
    _analysisProgress.delete("shot_list");
    notifyAnalysis();
  }
}

/**
 * EDL-driven shot list — frame-EXACT cuts + source provenance from the edit.
 *
 * Structure layer (instant, deterministic): one row per EDL event, timecodes
 * preserved in the EDL's own record base. Description layer: three frames
 * (in/middle/out) per shot from the cached MP4 → one Gemini call. Enrichment
 * layer (now): best-effort source from the clip name, flagged pending_db where
 * uncertain; raw clip + source TC retained for the later footage-DB join.
 */
export async function runShotListFromEdl() {
  const state = _store.getState();
  const project = state.project;
  const apiKey = state.apiKey;
  let videoBlobUrl = state.videoBlobUrl;

  if (!project?.edl || !Array.isArray(project.edl.events) || project.edl.events.length === 0) return;
  if (_analyzing.get("shot_list")) return;

  const events = project.edl.events as EdlEvent[];
  // The EDL only encodes drop/non-drop; the rate matches the project's detected
  // frame rate (FrameRate-typed, required by the timecode helpers).
  const frameRate = project.settings.frameRate;
  const dropFrame = project.edl.dropFrame ?? project.settings.dropFrame;
  const haveVideo = !!videoBlobUrl && !!apiKey;

  // Try to restore the cached blob on-demand if the video is expected but not attached.
  if (!videoBlobUrl && project.videoFile?.geminiFileUri) {
    try {
      const { loadVideoBlob } = await import("./blobStore");
      const blob = await loadVideoBlob(project.videoFile.geminiFileUri);
      if (blob) { const url = URL.createObjectURL(blob); _store.setVideoBlobUrl(url); videoBlobUrl = url; }
    } catch { /* non-fatal — clearance-list mode without descriptions */ }
  }

  _analyzing.set("shot_list", true);
  _analysisErrors.set("shot_list", "");
  _analysisProgress.delete("shot_list");
  clearDeliverable("shot_list"); // reset counter at run start
  notifyAnalysis();

  const abortController = new AbortController();
  _abortControllers.set("shot_list", abortController);
  const t0 = Date.now();

  try {
    // ─── Structure: one row per event, EDL record TC preserved ───
    const startOffsetFrames = edlTcToFrames(project.edl.startTC, frameRate, dropFrame);
    type Row = {
      tcIn: string; tcOut: string; duration: string;
      inSec: number; outSec: number; // MP4-relative (recTC − startOffset)
      sourceClip: string; sourceInTC: string; sourceOutTC: string;
      source: string; sourceConfidence: "resolved" | "pending_db"; transition: string;
      speed?: number;
    };
    const rows: Row[] = events.map((e) => {
      const recInF = edlTcToFrames(e.recInTC, frameRate, dropFrame);
      const recOutF = edlTcToFrames(e.recOutTC, frameRate, dropFrame);
      const src = resolveSource(e.clipName);
      return {
        tcIn: e.recInTC,
        tcOut: e.recOutTC,
        duration: subtractTimecodes(e.recOutTC, e.recInTC, frameRate, dropFrame),
        inSec: (recInF - startOffsetFrames) / frameRate,
        outSec: (recOutF - startOffsetFrames) / frameRate,
        sourceClip: e.clipName || "",
        sourceInTC: e.srcInTC,
        sourceOutTC: e.srcOutTC,
        source: src.source,
        sourceConfidence: src.confidence,
        transition: e.transition,
        speed: e.speed,
      };
    });
    const ramped = rows.filter((r) => r.speed != null && Math.abs(r.speed - 100) > 1).length;
    if (ramped) console.log(`[edl] ${ramped} speed-ramped shots flagged (slow-mo / reverse / fast)`);

    /** Map an M2 speed % to a human label. 100 = normal (no label). */
    const speedLabel = (sp: number | undefined): string => {
      if (sp == null || Math.abs(sp - 100) <= 1) return "";
      if (sp < 0) return `Reverse (${Math.abs(sp)}%)`;
      if (sp < 100) return `Slow motion (${sp}%)`;
      return `Fast motion (${sp}%)`;
    };
    console.log(`[edl] Structure: ${rows.length} shots from EDL (base ${project.edl.startTC}, ${frameRate}fps${dropFrame ? " DF" : ""})`);

    // ─── Description: 3 frames (in/mid/out) per shot → one Gemini call ───
    type Desc = { description: string; sceneType: string; cameraMovement: string; notes: string };
    const descriptions: (Desc | null)[] = new Array(rows.length).fill(null);

    if (haveVideo && videoBlobUrl) {
      const { GoogleGenAI } = await import("@google/genai");
      const ai = new GoogleGenAI({ apiKey });
      const { extractFrame } = await import("./frames");
      const describePrompt = SHOT_DESCRIBE_PROMPT(project.settings.language);
      const durSec = project.videoFile?.duration || Infinity;

      const describeOne = async (idx: number): Promise<void> => {
        if (_cancelFlags.get("shot_list") || abortController.signal.aborted) return;
        const r = rows[idx];
        // Three sample points within the shot, clamped inside the clip.
        // Inset 15% of the span (min 0.2s) from each cut: browser seeking is not
        // frame-exact, and a sample taken ~1 frame inside a cut routinely lands on the
        // ADJACENT shot — the model then blends two shots into one hallucinated description.
        // Shots too short for a safe inset are described from the midpoint alone.
        const span = Math.max(0, r.outSec - r.inSec);
        const inset = Math.max(0.2, span * 0.15);
        const mid = (r.inSec + r.outSec) / 2;
        const pts = (span < inset * 2.5 ? [mid] : [r.inSec + inset, mid, r.outSec - inset])
          .map((s) => Math.max(0, Math.min(s, durSec - 0.05)));
        const uniq = [...new Set(pts.map((s) => Math.round(s * 1000) / 1000))];
        const frames: string[] = [];
        for (const s of uniq) {
          try {
            const f = await extractFrame(videoBlobUrl!, secondsToTimecode(s, frameRate, dropFrame), frameRate);
            if (f) frames.push(f);
          } catch { /* skip this frame */ }
        }
        if (frames.length === 0) {
          descriptions[idx] = { description: "", sceneType: "", cameraMovement: "Static", notes: "[frame missing]" };
          return;
        }
        try {
          const parts = [
            ...frames.map((f) => ({ inlineData: { data: f.split(",")[1] ?? "", mimeType: "image/jpeg" } })),
            { text: describePrompt },
          ];
          const result = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: [{ role: "user", parts }],
            config: {
              temperature: 0.1, maxOutputTokens: 1024, responseMimeType: "application/json",
              thinkingConfig: { thinkingBudget: 0 }, abortSignal: abortController.signal,
            },
          });
          const parsed = parseJsonResponse(result.text ?? "");
          descriptions[idx] = {
            description: typeof parsed.description === "string" ? parsed.description.slice(0, 120) : "",
            sceneType: typeof parsed.sceneType === "string" ? parsed.sceneType : "",
            cameraMovement: typeof parsed.cameraMovement === "string" ? parsed.cameraMovement : "Static",
            notes: typeof parsed.notes === "string" ? parsed.notes : "",
          };
        } catch (err) {
          if (abortController.signal.aborted) return;
          descriptions[idx] = { description: "", sceneType: "", cameraMovement: "Static", notes: "[describe failed]" };
        }
      };

      console.log(`[edl] Description: 3-frame describe for ${rows.length} shots (concurrency=4)`);
      let done = 0, next = 0;
      const CONCURRENT = 4;
      const inFlight = new Set<Promise<void>>();
      while (next < rows.length || inFlight.size > 0) {
        while (inFlight.size < CONCURRENT && next < rows.length) {
          if (_cancelFlags.get("shot_list") || abortController.signal.aborted) break;
          const idx = next++;
          const p = describeOne(idx).finally(() => {
            inFlight.delete(p); done++;
            const totalMin = (project.videoFile?.duration || 3600) / 60;
            _analysisProgress.set("shot_list", { currentMin: (done / rows.length) * totalMin, totalMin });
            notifyAnalysis();
          });
          inFlight.add(p);
        }
        if (inFlight.size > 0) await Promise.race(inFlight);
        if (_cancelFlags.get("shot_list") || abortController.signal.aborted) break;
      }
      await Promise.all([...inFlight]);
    } else {
      console.warn("[edl] No video attached — producing clearance list (cuts + source, no descriptions)");
    }

    if (_cancelFlags.get("shot_list") || abortController.signal.aborted) return;

    // ─── Assemble ───
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shots: any[] = rows.map((r, i) => {
      const sp = speedLabel(r.speed);
      let cameraMovement = descriptions[i]?.cameraMovement || "Static";
      let notes = descriptions[i]?.notes || "";
      if (sp) {
        notes = notes ? `${notes} · ${sp}` : sp;
        if (!cameraMovement || cameraMovement === "Static") cameraMovement = sp;
      }
      return {
        shotNumber: i + 1,
        tcIn: r.tcIn,
        tcOut: r.tcOut,
        duration: r.duration,
        description: descriptions[i]?.description || (haveVideo ? "" : "[video required]"),
        sceneType: descriptions[i]?.sceneType || "",
        cameraMovement,
        notes,
        sourceClip: r.sourceClip,
        sourceInTC: r.sourceInTC,
        sourceOutTC: r.sourceOutTC,
        source: r.source,
        sourceConfidence: r.sourceConfidence,
        transition: r.transition,
        cutSource: "edl",
        location: "", // filled by fillLocationsFromGraphics() when location marks exist
      };
    });

    console.log(`[edl] Complete: ${shots.length} shots in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    applyResults("shot_list", shots, null, frameRate, dropFrame, /* preserveFrames */ true);
    // Back/forward-fill Location from any graphics location marks already present.
    fillLocationsFromGraphics();
  } catch (err) {
    console.error("[edl] Error:", err);
    _analysisErrors.set("shot_list", err instanceof Error ? err.message : "EDL shot list failed");
  } finally {
    _analyzing.set("shot_list", false);
    _cancelFlags.delete("shot_list");
    _abortControllers.delete("shot_list");
    _analysisProgress.delete("shot_list");
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

/**
 * Returns true if two shot descriptions share enough significant words to be
 * considered the same scene — used by the split-without-cut merge pass.
 *
 * Tune the threshold here:
 *   shared >= 2  →  loose  (merges when any 2 words > 3 chars match)
 *   shared >= 3  →  strict (safer for fast-cut sequences with repeated location words)
 */
function shotDescriptionsSimilar(a: string, b: string): boolean {
  // TODO: adjust threshold or logic to match your footage style
  const sig = (s: string) => new Set(s.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  const wa = sig(a);
  let shared = 0;
  for (const w of sig(b)) {
    if (wa.has(w) && ++shared >= 2) return true;
  }
  return false;
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

/**
 * Cross-module enrichment: propagate graphics LOCATION MARKS forward to fill the
 * Location column on every shot (and append to fauna notes). A location mark
 * ("HOBART / Tasmania", "POBITORA / India") applies from its timecode until the
 * next mark. This auto-fills Location — a column we'd otherwise need the footage
 * DB for — purely from the EDL cut grid + the OCR'd location marks.
 *
 * Idempotent and order-independent: called at the end of BOTH the shot and the
 * graphics generators, so whichever finishes second performs the fill. No-ops if
 * there are no location marks (never wipes existing data).
 */
function fillLocationsFromGraphics() {
  const project = _store.getState().project;
  if (!project) return;
  const fr = project.settings.frameRate;
  // Normalize a location mark to the COUNTRY (last "/"-segment) to match the house
  // LOC column: "WET TROPICS / FAR NORTH QUEENSLAND / AUSTRALIA" → "Australia".
  const toCountry = (content: string): string => {
    const cleaned = content.replace(/^location\s*mark:\s*/i, "").trim();
    // Marks separate place levels with "/", newline, OR comma — the country is
    // the LAST segment: "MIRISSA\nSRI LANKA" → "Sri Lanka", "WET TROPICS / … / AUSTRALIA" → "Australia".
    const seg = cleaned.split(/[/\n,]/).map((s) => s.trim()).filter(Boolean);
    const country = seg.length ? seg[seg.length - 1] : cleaned;
    return country.replace(/\s+/g, " ").split(" ").map((w) => w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w).join(" ");
  };
  const marks = (project.deliverables.graphicsList || [])
    .filter((g) => g.graphicType === "location_mark" && g.content)
    .map((g) => ({ sec: timecodeToSeconds(g.tcIn, fr), name: toCountry(g.content) }))
    .filter((m) => Number.isFinite(m.sec))
    .sort((a, b) => a.sec - b.sec);
  if (marks.length === 0) return;

  const locAt = (tc: string): string => {
    const s = timecodeToSeconds(tc, fr);
    // Backfill: shots before the first mark inherit the first mark's country.
    let cur = marks[0].name;
    for (const m of marks) { if (m.sec <= s + 0.5) cur = m.name; else break; }
    return cur;
  };

  const shots = project.deliverables.shotList;
  if (shots.length > 0) {
    const updated = shots.map((s) => ({ ...s, location: locAt(s.tcIn) }));
    _store.updateDeliverables({ shotList: updated });
    console.log(`[locations] Filled Location on ${updated.filter((s) => s.location).length}/${updated.length} shots from ${marks.length} location marks`);
  }
}

// Clip-name patterns that mark a graphics/CGI/title element in the EDL.
// Camera originals (A###C###, DJI_, P10…, GH#) and archive (T0###_TITLE) never match.
const GRAPHIC_CLIP_RE = /GFX|DRAFT|ARTWORK|UNTITLED|COMPOSIT|MIXDOWN|SIGNATUR|GRAFIK|\bCGI\b|ANIMAT|RENDER|ANGLE[-_ ]?\d|\bSI[_ ]?\d|CARBON|SCAT[_ ]?\d|\.PSD|\.AI|\.TIF|\.TGA|\.PNG/i;

function classifyGraphicClip(clip: string): "cgi" | "title_card" {
  const s = clip.toUpperCase();
  if (s.includes("SIGNATUR") || s.includes("MIXDOWN") || /^TR\s/.test(clip.trim().toUpperCase())) return "title_card";
  return "cgi";
}

/** Turn an EDL clip filename into readable graphic content (more accurate than a mid-frame guess). */
function cleanGraphicContent(clip: string): string {
  return clip
    .replace(/\.(NEW|COPY|SYNC)\b.*$/i, "")
    .replace(/\.(MP4|MOV|PSD|AI|TIF|TGA|PNG|JPE?G)\b.*$/i, "")
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Graphics via EDL-targeting (see docs spec + deep analysis).
 *  - CGI / Graphic Log: EDL graphic clips → frame-EXACT, content from the clip
 *    name (more accurate than a mid-frame Gemini guess — e.g. "CT SCAN",
 *    "CARBON SINK"). All 12 gold CGI are EDL clips.
 *  - Lower-thirds / location marks / inserts: NOT separate clips in the picture
 *    EDL, so read by OCR — but CHUNKED across the timeline so attention never
 *    decays (the old single whole-video call died after ~33 min). Timecodes are
 *    snapped into the EDL record base and de-duplicated (kills the phantom host
 *    supers).
 */
export async function runGraphicsFromEdl() {
  const state = _store.getState();
  const project = state.project;
  const apiKey = state.apiKey;
  if (!project?.edl || !Array.isArray(project.edl.events) || !apiKey) return;
  if (_analyzing.get("graphics_list")) return;

  const events = project.edl.events as EdlEvent[];
  const frameRate = project.settings.frameRate;
  const dropFrame = project.edl.dropFrame ?? project.settings.dropFrame;
  const language = project.settings.language;
  const baseSec = edlTcToFrames(project.edl.startTC, frameRate, dropFrame) / frameRate; // 10h record base
  const durationSec = project.videoFile?.duration || 0;

  _analyzing.set("graphics_list", true);
  _analysisErrors.set("graphics_list", "");
  _analysisProgress.delete("graphics_list");
  clearDeliverable("graphics_list");
  notifyAnalysis();
  const abortController = new AbortController();
  _abortControllers.set("graphics_list", abortController);

  try {
    const { GoogleGenAI } = await import("@google/genai");
    const ai = new GoogleGenAI({ apiKey });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entries: any[] = [];

    // ─── Part A: CGI / titles from EDL clips (frame-exact, deterministic) ───
    const gfx = events.filter((e) => e.clipName && GRAPHIC_CLIP_RE.test(e.clipName));
    for (const e of gfx) {
      entries.push({
        tcIn: e.recInTC, tcOut: e.recOutTC,
        graphicType: classifyGraphicClip(e.clipName!),
        content: cleanGraphicContent(e.clipName!),
        position: "full frame", notes: "From EDL (frame-exact)",
      });
    }
    console.log(`[edl-gfx] Part A: ${gfx.length} CGI/title clips from EDL`);

    // ─── Part B: lower-thirds / locations / inserts via CHUNKED OCR ───
    if (project.videoFile?.geminiFileUri && durationSec > 0) {
      const totalMin = durationSec / 60;
      const chunks: { startMin: number; endMin: number }[] = [];
      if (durationSec > CHUNK_THRESHOLD_SEC) {
        for (let st = 0; st < totalMin; st += CHUNK_MINUTES)
          chunks.push({ startMin: st, endMin: Math.min(st + CHUNK_MINUTES + OVERLAP_SEC / 60, totalMin) });
      } else chunks.push({ startMin: 0, endMin: totalMin });

      const extraNote = "\nDo NOT log a lower-third for the narrator/host/presenter (the recurring main person). Only log a lower-third the FIRST time a NEW interviewed person appears. Never repeat the same lower-third or location mark.";
      const ocr: { sec: number; tcOutSec: number; type: string; content: string; position: string; notes: string }[] = [];

      let chunkDone = 0;
      for (const ch of chunks) {
        if (_cancelFlags.get("graphics_list") || abortController.signal.aborted) break;
        const chunkOff = Math.floor(ch.startMin * 60);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const vp: any = { fileData: { fileUri: project.videoFile.geminiFileUri, mimeType: project.videoFile.type } };
        if (chunks.length > 1) vp.videoMetadata = { startOffset: `${chunkOff}s`, endOffset: `${Math.floor(ch.endMin * 60)}s` };
        try {
          const res = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: [{ role: "user", parts: [vp, { text: GRAPHICS_LIST_PROMPT(frameRate, dropFrame, language) + extraNote }] }],
            config: { temperature: 0.1, maxOutputTokens: 8192, responseMimeType: "application/json", thinkingConfig: { thinkingBudget: 0 }, mediaResolution: MediaResolution.MEDIA_RESOLUTION_LOW, abortSignal: abortController.signal },
          });
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const finishReason = (res as any).candidates?.[0]?.finishReason;
          if (finishReason === "MAX_TOKENS") {
            console.warn(`[edl-gfx] OCR chunk ${ch.startMin}-${ch.endMin}min: MAX_TOKENS — response may be truncated, some graphics may be missing`);
          }
          // Guard against hallucination loops before parsing (same as whole-video path).
          const rawText = truncateHallucinationLoop(res.text ?? "");
          if (!rawText.trim()) {
            console.warn(`[edl-gfx] OCR chunk ${ch.startMin}-${ch.endMin}min: empty response (finishReason=${finishReason}), skipping`);
          } else {
            const parsed = parseJsonResponse(rawText);
            const chEndSec = Math.floor(ch.endMin * 60);
            const winLen = chEndSec - chunkOff;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const cands: { gt: string; inS: number; outS: number; g: any }[] = [];
            for (const g of (Array.isArray(parsed.entries) ? parsed.entries : [])) {
              const gt = String(g.graphicType || "");
              if (!["lower_third", "location_mark", "title_card", "credit"].includes(gt)) continue;
              cands.push({
                gt,
                inS: timecodeToSeconds(String(g.tcIn || "00:00:00:00"), frameRate),
                outS: timecodeToSeconds(String(g.tcOut || g.tcIn || "00:00:00:00"), frameRate),
                g,
              });
            }
            // The prompt guarantees chunk-relative TCs, but the model sometimes returns
            // absolute ones anyway. Majority-vote across the chunk's entries (same fix as
            // the whole-video path): under which interpretation do more entries land
            // inside this chunk's window? A wrong guess double-shifts the chunk +chunkOff,
            // which is how SOUTHERN OCEAN graphics ended up 35 min past end of program.
            let useOffset = chunkOff;
            if (chunkOff > 0 && cands.length > 0) {
              let relVotes = 0, absVotes = 0;
              for (const c of cands) {
                if (c.inS >= 0 && c.inS <= winLen + 5) relVotes++;
                if (c.inS >= chunkOff - 5 && c.inS <= chEndSec + 5) absVotes++;
              }
              if (absVotes > relVotes) {
                console.warn(`[edl-gfx] OCR chunk ${ch.startMin}-${ch.endMin}min: TCs vote absolute (${absVotes} vs ${relVotes}) — skipping offset`);
                useOffset = 0;
              }
            }
            for (const c of cands) {
              const abs = c.inS + useOffset;
              const absOut = c.outS + useOffset;
              // Hard validation: must land inside this chunk's window and the program.
              if (abs < chunkOff - 5 || abs > chEndSec + 5 || abs > durationSec + 2) {
                console.warn(`[edl-gfx] Dropped out-of-window graphic "${String(c.g.content || "").slice(0, 40)}" at +${Math.round(abs)}s (chunk ${chunkOff}-${chEndSec}s, video ${Math.round(durationSec)}s)`);
                continue;
              }
              ocr.push({ sec: abs, tcOutSec: Math.max(absOut, abs + 1), type: c.gt, content: String(c.g.content || ""), position: String(c.g.position || ""), notes: String(c.g.notes || "") });
            }
          }
        } catch (err) {
          if (abortController.signal.aborted) break;
          console.warn(`[edl-gfx] OCR chunk ${ch.startMin}-${ch.endMin}min failed:`, err);
        }
        chunkDone++;
        _analysisProgress.set("graphics_list", { currentMin: (chunkDone / chunks.length) * totalMin, totalMin });
        notifyAnalysis();
      }

      // Dedup: lower_third/title/credit → first per normalized content;
      // location_mark → re-entry allowed if >120s since the last identical mark.
      ocr.sort((a, b) => a.sec - b.sec);
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const lastSeen = new Map<string, number>();
      let kept = 0;
      for (const o of ocr) {
        if (!norm(o.content)) continue;
        const key = `${o.type}|${norm(o.content)}`;
        const prev = lastSeen.get(key);
        const allowRe = o.type === "location_mark" ? 120 : Infinity;
        if (prev != null && (o.sec - prev) < allowRe) continue;
        lastSeen.set(key, o.sec);
        entries.push({
          tcIn: secondsToTimecode(o.sec + baseSec, frameRate, dropFrame),
          tcOut: secondsToTimecode(o.tcOutSec + baseSec, frameRate, dropFrame),
          graphicType: o.type, content: o.content, position: o.position, notes: o.notes,
        });
        kept++;
      }
      console.log(`[edl-gfx] Part B: ${kept} lower-thirds/locations from ${chunks.length} OCR chunks (deduped from ${ocr.length})`);
    }

    if (_cancelFlags.get("graphics_list") || abortController.signal.aborted) {
      console.log("[edl-gfx] Cancelled — discarding partial results");
    } else {
      entries.sort((a, b) => timecodeToSeconds(a.tcIn, frameRate) - timecodeToSeconds(b.tcIn, frameRate));
      console.log(`[edl-gfx] Complete: ${entries.length} graphics`);
      applyResults("graphics_list", entries, null, frameRate, dropFrame, /* preserveFrames */ true);
      fillLocationsFromGraphics();
    }
  } catch (err) {
    console.error("[edl-gfx] Error:", err);
    _analysisErrors.set("graphics_list", err instanceof Error ? err.message : "EDL graphics failed");
  } finally {
    _analyzing.set("graphics_list", false);
    _cancelFlags.delete("graphics_list");
    _abortControllers.delete("graphics_list");
    _analysisProgress.delete("graphics_list");
    notifyAnalysis();
  }
}

/**
 * A 3-field timecode is ambiguous: MM:SS:FF (Gemini dropped the hours) vs
 * HH:MM:SS (Gemini dropped the frames). The ONLY reliable discriminator is the
 * frame constraint — a frame number cannot exceed the frame rate. So if the
 * third field is greater than the nominal fps it can't be frames, and the TC
 * must be HH:MM:SS. At/below fps we keep the MM:SS:FF reading (the historical
 * default; the `<=` also tolerates the frame==fps rollover Gemini sometimes
 * emits at second boundaries). Fields ≥ 60 in the first two positions can never
 * be MM/SS, so those force HH:MM:SS too.
 *
 * When fps is unknown (legacy sort/dedup callers) we fall back to the original
 * "frames < 60" rule so their behaviour is byte-identical to before.
 *
 * Shared by tcToSec, shiftTc and applyResults' normalizeTimecode so the three
 * cannot silently drift apart again.
 */
function threePartIsMMSSFF(p0: number, p1: number, p2: number, fps?: number): boolean {
  if (p0 >= 60 || p1 >= 60) return false; // MM/SS out of range → HH:MM:SS
  const frameCap = fps !== undefined ? Math.round(fps) : 59;
  return p2 <= frameCap; // plausible frame number → MM:SS:FF
}

/** Parse a TC string to whole seconds (ignores frames). Returns 0 for unrecognised input.
 *  Pass `fps` to disambiguate 3-field TCs by the frame constraint (see threePartIsMMSSFF). */
function tcToSec(tc: string, fps?: number): number {
  const parts = tc.replace(/[;]/g, ":").split(":").map(Number);
  if (parts.length === 4) {
    const [h, m, s] = parts;
    return h * 3600 + m * 60 + s;
  }
  if (parts.length === 3) {
    if (threePartIsMMSSFF(parts[0], parts[1], parts[2], fps)) {
      return parts[0] * 60 + parts[1]; // MM:SS:FF — ignore frames
    }
    return parts[0] * 3600 + parts[1] * 60 + parts[2]; // HH:MM:SS (now reachable)
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
    // Disambiguate MM:SS:FF vs HH:MM:SS via the frame constraint (see threePartIsMMSSFF).
    if (threePartIsMMSSFF(parts[0], parts[1], parts[2], fps)) {
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
function applyResults(type: AnalysisType, entries: any[], directParsed: any, frameRate: FrameRate, dropFrame: boolean, preserveFrames: boolean = false) {
  const normalizeTimecode = (tc: unknown): string => {
    if (typeof tc !== "string") return dropFrame ? "00:00:00;00" : "00:00:00:00";
    const sep = dropFrame ? ";" : ":";
    const cleaned = tc.replace(/[;]/g, ":");
    const parts = cleaned.split(":");
    if (parts.length === 4) {
      // EDL-sourced timecodes are frame-EXACT (gold) — preserve the frame field.
      // For AI-derived cuts we zero it: Gemini can't detect frame-accurate cuts
      // and emits artificial offsets (:08, :16, :24), so :00 is more honest.
      const ff = preserveFrames ? parts[3].padStart(2, "0") : "00";
      return `${parts[0].padStart(2,"0")}:${parts[1].padStart(2,"0")}:${parts[2].padStart(2,"0")}${sep}${ff}`;
    }
    if (parts.length === 3) {
      const first = parseInt(parts[0], 10);
      const second = parseInt(parts[1], 10);
      const third = parseInt(parts[2], 10);
      // Disambiguate MM:SS:FF vs HH:MM:SS via the frame constraint (see
      // threePartIsMMSSFF). The frame cap still tolerates the frame==fps rollover
      // Gemini sometimes emits at second boundaries (e.g. frame 24 at 24fps).
      if (threePartIsMMSSFF(first, second, third, frameRate)) {
        return `00:${parts[0].padStart(2, "0")}:${parts[1].padStart(2, "0")}${sep}${parts[2].padStart(2, "0")}`;
      }
      return `${parts[0].padStart(2, "0")}:${parts[1].padStart(2, "0")}:${parts[2].padStart(2, "0")}${sep}00`;
    }
    return dropFrame ? "00:00:00;00" : "00:00:00:00";
  };

  // X1 — unify timecode base. AI modules (dialogue/talent/fauna) emit 0-based
  // video timecodes; when an EDL is attached, shift them into the EDL's record
  // base (e.g. 10:00:00:00) so every module is consistent with the EDL-sourced
  // shots/graphics. EDL paths pass preserveFrames=true and are already in-base,
  // so they are NOT shifted. Position fields only — never duration (a delta).
  // startTC is an EDL record timecode — its drop-frame-ness is defined by the EDL
  // (FCM line), not by the whole-video module's settings, so prefer the EDL flag.
  const proj = _store.getState().project;
  const baseOffsetSec = (!preserveFrames && proj?.edl)
    ? edlTcToFrames(proj.edl.startTC, frameRate, proj.edl.dropFrame ?? dropFrame) / frameRate
    : 0;
  const shiftPos = (tc: string): string =>
    baseOffsetSec ? secondsToTimecode(timecodeToSeconds(tc, frameRate) + baseOffsetSec, frameRate, dropFrame) : tc;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const normalizeEntry = (e: any) => {
    const r = { ...e };
    for (const key of ["tcIn", "tcOut", "firstAppearance"]) {
      if (key in r) r[key] = shiftPos(normalizeTimecode(r[key])); // position → shift to EDL base
    }
    if ("duration" in r) r.duration = normalizeTimecode(r.duration); // delta → never shift
    if (Array.isArray(r.appearances)) {
      r.appearances = r.appearances.map((tc: unknown) => shiftPos(normalizeTimecode(tc)));
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
    // EDL-sourced shot lists are a faithful 1:1 mirror of the timeline — never
    // collapse "repetitive" rows (a montage of similar shots is real, and the
    // anti-hallucination dedupe would silently drop real cuts and break parity).
    const deduped = preserveFrames ? items : dedupeRepetitions(items);
    if (deduped.length < items.length) {
      console.warn(`[analyze] Removed ${items.length - deduped.length} repetitive hallucinated entries`);
    }
    return deduped.map((e, i) => ({ ...normalizeEntry(e), id: crypto.randomUUID(), shotNumber: i + 1 }));
  };

  // D1 — normalize speaker labels: collapse a short name to a longer one ONLY when
  // it is an unambiguous prefix/substring of exactly one fuller speaker present
  // (e.g. "ASHA" → "ASHA DE VOS"). Ambiguous cases ("SCOTT" when both SCOTT
  // CARVER and SCOTT BURNETT exist) are left untouched.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const normalizeSpeakers = (items: any[]): any[] => {
    const names = [...new Set(items.map((e) => String(e.speaker || "").trim()).filter(Boolean))];
    const map = new Map<string, string>();
    for (const short of names) {
      if (short === "NARRATOR" || short.length < 3) continue;
      const fuller = names.filter((n) => n !== short && n.length > short.length &&
        n.toUpperCase().includes(short.toUpperCase()));
      if (fuller.length === 1) map.set(short, fuller[0]); // unambiguous only
    }
    if (map.size === 0) return items;
    console.log(`[analyze] Normalized speaker labels: ${[...map].map(([a, b]) => `${a}→${b}`).join(", ")}`);
    return items.map((e) => map.has(String(e.speaker || "").trim()) ? { ...e, speaker: map.get(e.speaker.trim()) } : e);
  };

  switch (type) {
    case "shot_list":
      _store.updateDeliverables({ shotList: addIds(entries) });
      break;
    case "dialogue_list":
      _store.updateDeliverables({ dialogueList: normalizeSpeakers(addIds(entries)) });
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

/**
 * Detect the frame rate of an uploaded video by sampling decoded frames.
 *
 * Uses `requestVideoFrameCallback` — fires once per decoded frame with a precise
 * mediaTime. We sample N frames, take the median inter-frame delta, and snap to
 * the nearest broadcast-standard rate (24/25/29.97/30/50/59.94/60/23.976).
 *
 * Falls back to 25 fps if detection is unsupported (older browsers) or fails.
 *
 * NOTE: requestVideoFrameCallback is supported in Chrome 87+, Safari 15.4+,
 * Firefox 132+. All modern targets.
 */
async function detectFrameRate(file: File): Promise<FrameRate> {
  const STANDARD_RATES: FrameRate[] = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];
  const FALLBACK: FrameRate = 25;
  const SAMPLE_COUNT = 12;

  return new Promise<FrameRate>((resolve) => {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";

    const url = URL.createObjectURL(file);
    let resolved = false;
    const finish = (rate: FrameRate, reason: string) => {
      if (resolved) return;
      resolved = true;
      console.log(`[upload] Frame rate detected: ${rate} fps (${reason})`);
      URL.revokeObjectURL(url);
      video.removeAttribute("src");
      video.load();
      resolve(rate);
    };

    // Safety timeout — if detection stalls, fall back.
    const timeoutId = setTimeout(() => finish(FALLBACK, "detection timed out"), 8000);

    // Feature-detect requestVideoFrameCallback
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const videoEl: any = video;
    if (typeof videoEl.requestVideoFrameCallback !== "function") {
      clearTimeout(timeoutId);
      finish(FALLBACK, "requestVideoFrameCallback unsupported");
      return;
    }

    video.onerror = () => {
      clearTimeout(timeoutId);
      finish(FALLBACK, "video load error");
    };

    video.onloadedmetadata = () => {
      // Start ~1 second in to avoid intro splash variability
      video.currentTime = Math.min(1, (video.duration || 0) * 0.05);
    };

    video.onseeked = () => {
      const timestamps: number[] = [];
      const onFrame = (_: DOMHighResTimeStamp, metadata: { mediaTime: number }) => {
        timestamps.push(metadata.mediaTime);
        if (timestamps.length >= SAMPLE_COUNT) {
          video.pause();
          clearTimeout(timeoutId);
          // Median inter-frame delta
          const deltas: number[] = [];
          for (let i = 1; i < timestamps.length; i++) {
            const d = timestamps[i] - timestamps[i - 1];
            if (d > 0) deltas.push(d);
          }
          if (deltas.length === 0) return finish(FALLBACK, "no inter-frame deltas captured");
          deltas.sort((a, b) => a - b);
          const median = deltas[Math.floor(deltas.length / 2)];
          const rawFps = 1 / median;
          // Snap to nearest standard rate
          const snapped = STANDARD_RATES.reduce((best, r) =>
            Math.abs(r - rawFps) < Math.abs(best - rawFps) ? r : best
          );
          finish(snapped, `raw=${rawFps.toFixed(3)}fps → snapped`);
          return;
        }
        videoEl.requestVideoFrameCallback(onFrame);
      };
      videoEl.requestVideoFrameCallback(onFrame);
      video.play().catch(() => finish(FALLBACK, "playback blocked"));
    };

    video.src = url;
  });
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

    // Step 0a: Extract video duration using browser <video> element
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

    // Step 0b: Auto-detect frame rate. This replaces the manual selector in
    // SettingsPanel — the detected rate becomes the project's framerate for
    // all timecode math downstream. Falls back to 25 if detection fails.
    let detectedFrameRate: FrameRate = project.settings.frameRate; // current as fallback
    try {
      detectedFrameRate = await detectFrameRate(file);
    } catch (e) {
      console.warn("[upload] Frame rate detection failed, keeping current:", e);
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

    // New upload — wipe any previous analysis so stale results are never shown.
    // The detected frame rate becomes the project's framerate for all timecode math.
    _store.updateProject({
      videoFile: {
        name: file.name,
        size: file.size,
        type: mimeType,
        duration: videoDuration,
        frameRate: detectedFrameRate,
        uploadedAt: new Date().toISOString(),
        geminiFileUri: geminiFile.uri!,
      },
      settings: {
        ...project.settings,
        frameRate: detectedFrameRate,
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

    // Persist the raw bytes to IndexedDB so a page refresh doesn't force a
    // re-upload. Keyed by the Gemini URI: hydrateStore() will fetch this and
    // reattach a fresh Blob URL in ~1 second next time the page loads. Best-
    // effort — failure here is non-fatal (the in-memory blob URL still works
    // for THIS session).
    try {
      const { saveVideoBlob } = await import("./blobStore");
      await saveVideoBlob(geminiFile.uri!, file, {
        name: file.name, type: mimeType, size: file.size,
      });
      console.log(`[upload] Cached ${(file.size/1024/1024).toFixed(1)}MB blob to IndexedDB for fast restore`);
    } catch (e) {
      console.warn("[upload] Could not cache blob for restore (non-fatal):", e);
    }

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
