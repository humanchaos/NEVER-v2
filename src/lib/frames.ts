"use client";

import { FrameRate } from "./types";
import { timecodeToSeconds } from "./timecode";

const THUMB_WIDTH = 160;
const THUMB_HEIGHT = 90;

// Cache extracted frames to avoid re-seeking
const frameCache = new Map<string, string>();

// Concurrency limiter — Chrome crashes if too many <video> elements exist simultaneously.
// Queue all extraction requests; process at most MAX_CONCURRENT at a time.
const MAX_CONCURRENT = 4;
let _running = 0;
const _queue: Array<() => void> = [];

function acquireSemaphore(): Promise<void> {
  return new Promise((resolve) => {
    const tryRun = () => {
      if (_running < MAX_CONCURRENT) {
        _running++;
        resolve();
      } else {
        _queue.push(tryRun);
      }
    };
    tryRun();
  });
}

function releaseSemaphore() {
  _running--;
  const next = _queue.shift();
  if (next) next();
}

/**
 * Extract a single frame from a video at a given timecode.
 * Returns a data URL (JPEG) of the frame thumbnail.
 */
export function extractFrame(
  videoBlobUrl: string,
  timecode: string,
  frameRate: FrameRate
): Promise<string> {
  const cacheKey = `${videoBlobUrl}:${timecode}`;
  const cached = frameCache.get(cacheKey);
  if (cached) return Promise.resolve(cached);

  return acquireSemaphore().then(() => new Promise<string>((resolve, reject) => {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.preload = "auto";

    const seconds = timecodeToSeconds(timecode, frameRate);
    let done = false;

    const cleanup = () => {
      clearTimeout(timeoutId);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
      video.src = "";
      video.load();
      releaseSemaphore();
    };

    // Safety timeout — if loadedmetadata or seeked never fires, release the
    // semaphore so the queue doesn't deadlock and the spinner stops.
    const timeoutId = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error(`Frame extraction timed out at ${timecode}`));
    }, 12000);

    const onSeeked = () => {
      if (done) return;
      done = true;
      try {
        const canvas = document.createElement("canvas");
        canvas.width = THUMB_WIDTH;
        canvas.height = THUMB_HEIGHT;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(video, 0, 0, THUMB_WIDTH, THUMB_HEIGHT);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
        frameCache.set(cacheKey, dataUrl);
        cleanup();
        resolve(dataUrl);
      } catch (err) {
        cleanup();
        reject(err);
      }
    };

    const onError = () => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error("Failed to load video for frame extraction"));
    };

    // Attach seeked before setting src — original working order.
    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });

    video.src = videoBlobUrl;
    video.addEventListener(
      "loadedmetadata",
      () => {
        video.currentTime = Math.min(seconds, video.duration - 0.1);
      },
      { once: true }
    );
  }));
}

/**
 * Batch-extract frames for a list of timecodes.
 * Uses a shared video element and sequential seeking to avoid overwhelming the browser.
 */
export async function extractFramesBatch(
  videoBlobUrl: string,
  timecodes: string[],
  frameRate: FrameRate,
  onProgress?: (done: number, total: number) => void
): Promise<Map<string, string>> {
  const results = new Map<string, string>();

  // Deduplicate timecodes
  const unique = [...new Set(timecodes)];

  for (let i = 0; i < unique.length; i++) {
    try {
      const dataUrl = await extractFrame(videoBlobUrl, unique[i], frameRate);
      results.set(unique[i], dataUrl);
    } catch {
      // Skip failed frames
    }
    onProgress?.(i + 1, unique.length);
  }

  return results;
}

/**
 * Clear the frame cache (e.g., when switching projects).
 */
export function clearFrameCache() {
  frameCache.clear();
}
