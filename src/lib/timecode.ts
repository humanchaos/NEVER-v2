import { FrameRate } from "./types";

/**
 * Professional broadcast timecode utilities.
 * Handles NDF (Non-Drop-Frame) and DF (Drop-Frame) timecodes
 * for all standard broadcast frame rates.
 */

export function secondsToTimecode(
  totalSeconds: number,
  frameRate: FrameRate,
  dropFrame: boolean = false
): string {
  if (totalSeconds < 0) return dropFrame ? "00:00:00;00" : "00:00:00:00";

  const totalFrames = Math.floor(totalSeconds * frameRate);
  return framesToTimecode(totalFrames, frameRate, dropFrame);
}

export function framesToTimecode(
  totalFrames: number,
  frameRate: FrameRate,
  dropFrame: boolean = false
): string {
  if (totalFrames < 0) totalFrames = 0;

  const separator = dropFrame ? ";" : ":";
  const nominalFps = Math.round(frameRate);

  if (dropFrame && (frameRate === 29.97 || frameRate === 59.94)) {
    const dropFrames = frameRate === 29.97 ? 2 : 4;
    const framesPerMinute = nominalFps * 60 - dropFrames;
    const framesPer10Min = framesPerMinute * 10 + dropFrames;

    const d = Math.floor(totalFrames / framesPer10Min);
    const m = totalFrames % framesPer10Min;

    let adjustedFrames = totalFrames;
    if (m >= dropFrames) {
      adjustedFrames += dropFrames * (Math.floor((m - dropFrames) / framesPerMinute) + d * 9);
    } else {
      adjustedFrames += dropFrames * d * 9;
    }

    const ff = adjustedFrames % nominalFps;
    const ss = Math.floor(adjustedFrames / nominalFps) % 60;
    const mm = Math.floor(adjustedFrames / (nominalFps * 60)) % 60;
    const hh = Math.floor(adjustedFrames / (nominalFps * 3600));

    return `${pad(hh)}:${pad(mm)}:${pad(ss)}${separator}${pad(ff)}`;
  }

  const ff = totalFrames % nominalFps;
  const totalSecs = Math.floor(totalFrames / nominalFps);
  const ss = totalSecs % 60;
  const mm = Math.floor(totalSecs / 60) % 60;
  const hh = Math.floor(totalSecs / 3600);

  return `${pad(hh)}:${pad(mm)}:${pad(ss)}${separator}${pad(ff)}`;
}

export function timecodeToSeconds(
  timecode: string,
  frameRate: FrameRate
): number {
  const cleaned = timecode.replace(/[;]/g, ":");
  const parts = cleaned.split(":").map(Number);

  if (parts.length === 4) {
    const [hh, mm, ss, ff] = parts;
    return hh * 3600 + mm * 60 + ss + ff / frameRate;
  }
  if (parts.length === 3) {
    const [hh, mm, ss] = parts;
    return hh * 3600 + mm * 60 + ss;
  }
  return 0;
}

export function timecodeToFrames(
  timecode: string,
  frameRate: FrameRate,
  dropFrame: boolean = false
): number {
  const isDF = timecode.includes(";") || dropFrame;
  const cleaned = timecode.replace(/[;]/g, ":");
  const parts = cleaned.split(":").map(Number);

  let hh: number, mm: number, ss: number, ff: number;
  if (parts.length === 4) {
    [hh, mm, ss, ff] = parts;
  } else if (parts.length === 3) {
    [hh, mm, ss] = parts;
    ff = 0;
  } else {
    return 0;
  }
  const nominalFps = Math.round(frameRate);

  let totalFrames = hh * 3600 * nominalFps + mm * 60 * nominalFps + ss * nominalFps + ff;

  if (isDF && (frameRate === 29.97 || frameRate === 59.94)) {
    const dropFrames = frameRate === 29.97 ? 2 : 4;
    const totalMinutes = hh * 60 + mm;
    totalFrames -= dropFrames * (totalMinutes - Math.floor(totalMinutes / 10));
  }

  return totalFrames;
}

export function addTimecodes(
  tc1: string,
  tc2: string,
  frameRate: FrameRate,
  dropFrame: boolean = false
): string {
  const frames1 = timecodeToFrames(tc1, frameRate, dropFrame);
  const frames2 = timecodeToFrames(tc2, frameRate, dropFrame);
  return framesToTimecode(frames1 + frames2, frameRate, dropFrame);
}

export function subtractTimecodes(
  tc1: string,
  tc2: string,
  frameRate: FrameRate,
  dropFrame: boolean = false
): string {
  const frames1 = timecodeToFrames(tc1, frameRate, dropFrame);
  const frames2 = timecodeToFrames(tc2, frameRate, dropFrame);
  return framesToTimecode(Math.max(0, frames1 - frames2), frameRate, dropFrame);
}

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function formatFileSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${bytes} B`;
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}
