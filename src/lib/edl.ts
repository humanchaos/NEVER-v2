/**
 * CMX 3600 EDL parser — reusable foundation for the shot list (and later
 * Graphics/Talent) modules.
 *
 * Why: the human shotlist is derived from the edit timeline, not the rendered
 * video. An EDL of the locked sequence gives frame-EXACT cut points and the
 * source clip per shot — data that pixels threw away. Measured against the T0189
 * gold list, EDL record-in cuts match at 0.999 exact-frame recall.
 *
 * This is a pure parser: no DOM, no AI. See
 * docs/superpowers/specs/2026-06-03-edl-shotlist-pipeline-design.md.
 */

export type EdlTransition = "cut" | "dissolve" | "wipe" | "key";

export interface EdlEvent {
  /** Event number as written (has gaps when audio events are dropped). */
  num: number;
  reel: string;
  /** Raw track field, e.g. "V", "B", "A", "A2", "AA", "NONE". */
  track: string;
  transition: EdlTransition;
  /** Transition duration in frames (dissolve/wipe), else 0. */
  transitionFrames: number;
  srcInTC: string;
  srcOutTC: string;
  recInTC: string;
  recOutTC: string;
  clipName: string | null;
  /** Speed % from an M2 motion-effect line (100 = normal), if present. */
  speed?: number;
}

export interface EdlData {
  fileName: string;
  /** Record-in of the first kept (video) event — the timeline base. Dynamic, never hard-coded. */
  startTC: string;
  dropFrame: boolean;
  fps: number;
  events: EdlEvent[];
  warnings: string[];
}

const TC = String.raw`\d{2}:\d{2}:\d{2}[:;]\d{2}`;
// Event line: num  reel  track  edit[ dur]  srcIn srcOut recIn recOut
const EVENT_RE = new RegExp(
  String.raw`^(\d+)\s+(\S+)\s+(\S+)\s+([A-Z]+\d*)\s+(?:(\d+)\s+)?(${TC})\s+(${TC})\s+(${TC})\s+(${TC})`
);
const M2_RE = new RegExp(String.raw`^M2\s+(\S+)\s+(-?[\d.]+)`);

/**
 * Parse an HH:MM:SS:FF (or ;FF drop) timecode to whole frames at fps.
 *
 * Drop-frame handling mirrors timecode.ts `timecodeToFrames` — keep the two in
 * sync. For 29.97/59.94 DF, the timecode LABELS skip frame numbers (2 or 4 per
 * minute, except every 10th minute) to track wall-clock, so the naive
 * `hms * nominalFps + frames` overcounts by ~108 frames/hr at 29.97 (~3.6 s/hr).
 * We subtract those dropped labels to recover the true frame index.
 *
 * `dropFrame` is authoritative (from the EDL's FCM line); a `;` separator in the
 * string is also treated as a DF signal, matching timecode.ts.
 */
export function edlTcToFrames(tc: string, fps: number, dropFrame: boolean = false): number {
  const m = tc.match(/(\d{2}):(\d{2}):(\d{2})[:;](\d{2})/);
  if (!m) return 0;
  const [, h, mm, s, f] = m;
  const nominalFps = Math.round(fps);
  let totalFrames = ((+h * 60 + +mm) * 60 + +s) * nominalFps + +f;

  const isDF = dropFrame || tc.includes(";");
  if (isDF && (fps === 29.97 || fps === 59.94)) {
    const dropFrames = fps === 29.97 ? 2 : 4;
    const totalMinutes = +h * 60 + +mm;
    totalFrames -= dropFrames * (totalMinutes - Math.floor(totalMinutes / 10));
  }
  return totalFrames;
}

/** Frames → seconds at fps. */
export function framesToSeconds(frames: number, fps: number): number {
  return frames / fps;
}

function transitionOf(edit: string): EdlTransition {
  if (edit === "C") return "cut";
  if (edit === "D") return "dissolve";
  if (edit.startsWith("W")) return "wipe";
  if (edit.startsWith("K")) return "key";
  return "cut"; // unknown → treat as a hard boundary
}

/** Video tracks we keep. B = video+audio on one event. */
function isVideoTrack(track: string): boolean {
  const t = track.toUpperCase();
  return t === "V" || t === "B" || t.startsWith("V");
}

/**
 * Parse CMX 3600 EDL text. Robust to: FCM drop/non-drop (most-recent applies),
 * M2 speed ramps (attached to their event, not rowed), dissolves/wipes/keys
 * (flagged; the incoming event's record-in is the boundary), audio-only events
 * (ignored; their num gaps don't affect downstream numbering), and unknown
 * comment lines (ignored, not errors).
 *
 * fps is taken from the caller (the project's detected frame rate); the EDL only
 * encodes drop/non-drop via FCM, not the rate itself.
 */
export function parseEdl(text: string, fileName: string, fps: number): EdlData {
  const lines = text.split(/\r?\n/);
  const warnings: string[] = [];
  let dropFrame = false;

  // Parse ALL events (kept or not) so comments/M2 attach to their own event.
  const raw: EdlEvent[] = [];
  let last: EdlEvent | null = null;

  for (const line of lines) {
    if (/^FCM:/i.test(line)) {
      dropFrame = /DROP/i.test(line) && !/NON-?DROP/i.test(line);
      continue;
    }
    const m2 = line.match(M2_RE);
    if (m2 && last) {
      const sp = parseFloat(m2[2]);
      if (!Number.isNaN(sp)) last.speed = sp;
      continue;
    }
    if (/^\*\s*FROM CLIP NAME:/i.test(line)) {
      if (last && last.clipName === null) {
        last.clipName = line.split(/:/, 2)[1]?.trim() || line.replace(/^\*\s*FROM CLIP NAME:/i, "").trim();
      }
      continue;
    }
    if (line.startsWith("*") || line.startsWith("TITLE:") || line.trim() === "") continue;

    const m = line.match(EVENT_RE);
    if (m) {
      const [, num, reel, track, edit, dur, srcIn, srcOut, recIn, recOut] = m;
      const ev: EdlEvent = {
        num: parseInt(num, 10),
        reel,
        track,
        transition: transitionOf(edit),
        transitionFrames: dur ? parseInt(dur, 10) : 0,
        srcInTC: srcIn,
        srcOutTC: srcOut,
        recInTC: recIn,
        recOutTC: recOut,
        clipName: null,
      };
      raw.push(ev);
      last = ev;
    } else if (/^\d/.test(line)) {
      warnings.push(`Unparsed event line: ${line.slice(0, 60)}`);
    }
  }

  const events = raw.filter((e) => isVideoTrack(e.track));
  const startTC = events.length > 0 ? events[0].recInTC : "00:00:00:00";

  return { fileName, startTC, dropFrame, fps, events, warnings };
}
