"use client";

import { useEffect, useState } from "react";
import { useStore } from "@/lib/store";
import { extractFrame } from "@/lib/frames";
import { FrameRate } from "@/lib/types";

interface ThumbnailProps {
  timecode: string;
  frameRate: FrameRate;
  className?: string;
  width?: number;
  height?: number;
}

export default function Thumbnail({ timecode, frameRate, className = "", width = 120, height = 68 }: ThumbnailProps) {
  const videoBlobUrl = useStore((s) => s.videoBlobUrl);
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!videoBlobUrl || !timecode) return;

    let cancelled = false;
    setSrc(null);
    setLoading(true);

    extractFrame(videoBlobUrl, timecode, frameRate)
      .then((dataUrl) => {
        if (!cancelled) {
          setSrc(dataUrl);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [videoBlobUrl, timecode, frameRate]);

  if (!videoBlobUrl) return null;

  return (
    <div
      className={`relative bg-background rounded overflow-hidden shrink-0 ${className}`}
      style={{ width, height }}
    >
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="w-4 h-4 border-2 border-accent/20 border-t-accent-light rounded-full animate-spin" />
        </div>
      )}
      {src && (
        <img
          src={src}
          alt={`Frame at ${timecode}`}
          className="w-full h-full object-cover"
        />
      )}
      {!loading && !src && (
        <div className="absolute inset-0 flex items-center justify-center">
          <svg className="w-5 h-5 text-muted/40" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0022.5 18.75V5.25A2.25 2.25 0 0020.25 3H3.75A2.25 2.25 0 001.5 5.25v13.5A2.25 2.25 0 003.75 21z" />
          </svg>
        </div>
      )}
      {/* Timecode overlay */}
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent px-1.5 py-0.5">
        <span className="tc text-[9px] text-white/80">{timecode}</span>
      </div>
    </div>
  );
}
