"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { ActivePanel } from "@/app/page";
import { useStore, store, runUpload, getUploadState, subscribeUpload, resetUploadState, type UploadState } from "@/lib/store";
import { formatFileSize } from "@/lib/timecode";
import { FrameRate, FRAME_RATES, Broadcaster, BROADCASTERS } from "@/lib/types";

interface UploadPanelProps {
  onNavigate: (panel: ActivePanel) => void;
}

export default function UploadPanel({ onNavigate }: UploadPanelProps) {
  const project = useStore((s) => s.project);
  const apiKey = useStore((s) => s.apiKey);
  const [isDragging, setIsDragging] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Upload state from store — survives navigation
  const [uploadStoreState, setUploadStoreState] = useState<UploadState>(getUploadState);
  useEffect(() => {
    setUploadStoreState(getUploadState());
    const unsub = subscribeUpload(() => setUploadStoreState(getUploadState()));
    return () => { unsub(); };
  }, []);
  const uploadState = uploadStoreState.status;
  const uploadProgress = uploadStoreState.progress;
  const error = localError || uploadStoreState.error;

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2GB — Gemini Files API hard limit

  const selectFile = useCallback((file: File) => {
    if (file.size > MAX_FILE_SIZE) {
      setLocalError(`File is ${formatFileSize(file.size)} — exceeds Gemini's 2GB limit. Please use a lower-resolution proxy file.`);
      return;
    }
    setLocalError(null);
    resetUploadState();
    setSelectedFile(file);
    // Create blob URL for frame extraction later
    const url = URL.createObjectURL(file);
    store.setVideoBlobUrl(url);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) selectFile(file);
  }, [selectFile]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) selectFile(file);
  }, [selectFile]);

  const handleUpload = () => {
    if (!selectedFile || !apiKey || !project) return;
    setLocalError(null);
    runUpload(selectedFile, () => {
      setTimeout(() => onNavigate("deliverables"), 1500);
    });
  };

  const updateSetting = <K extends keyof NonNullable<typeof project>["settings"]>(
    key: K,
    value: NonNullable<typeof project>["settings"][K]
  ) => {
    if (!project) return;
    store.updateProject({
      settings: { ...project.settings, [key]: value },
    });
  };

  if (!project) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <p className="text-muted-light mb-4">Create a project first</p>
          <button
            onClick={() => onNavigate("dashboard")}
            className="px-4 py-2 bg-accent text-white rounded-lg text-sm"
          >
            Go to Dashboard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-3xl mx-auto">
      <div className="mb-8 animate-fade-in">
        <div className="text-xs tracking-[0.25em] uppercase text-accent font-medium mb-1">Master Ingest</div>
        <h2 className="text-2xl font-bold tracking-tight">Upload Master File</h2>
        <p className="text-muted text-sm mt-1">MP4, MOV, AVI, WebM &middot; Up to 2GB</p>
      </div>

      {/* Project Settings */}
      <div className="bg-surface border border-border rounded-xl p-6 mb-6 animate-slide-up">
        <h3 className="text-[10px] font-semibold text-muted uppercase tracking-[0.2em] mb-4">Project Settings</h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-muted mb-1.5">Frame Rate</label>
            <select
              value={project.settings.frameRate}
              onChange={(e) => updateSetting("frameRate", parseFloat(e.target.value) as FrameRate)}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-foreground focus:outline-none focus:border-accent"
            >
              {FRAME_RATES.map((fr) => (
                <option key={fr} value={fr}>{fr} fps</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-muted mb-1.5">Broadcaster</label>
            <select
              value={project.settings.broadcaster}
              onChange={(e) => updateSetting("broadcaster", e.target.value as Broadcaster)}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-foreground focus:outline-none focus:border-accent"
            >
              {BROADCASTERS.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-muted mb-1.5">Timecode Mode</label>
            <div className="flex gap-2">
              <button
                onClick={() => updateSetting("dropFrame", false)}
                className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                  !project.settings.dropFrame
                    ? "bg-accent/10 border-accent/30 text-accent-light"
                    : "bg-background border-border text-muted hover:text-foreground"
                }`}
              >
                NDF
              </button>
              <button
                onClick={() => updateSetting("dropFrame", true)}
                className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                  project.settings.dropFrame
                    ? "bg-accent/10 border-accent/30 text-accent-light"
                    : "bg-background border-border text-muted hover:text-foreground"
                }`}
              >
                DF
              </button>
            </div>
          </div>
          <div>
            <label className="block text-xs text-muted mb-1.5">Output Language</label>
            <select
              value={project.settings.language}
              onChange={(e) => updateSetting("language", e.target.value)}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-foreground focus:outline-none focus:border-accent"
            >
              <option value="auto">Auto-detect (match clip language)</option>
              <option value="en">English</option>
              <option value="de">Deutsch</option>
              <option value="fr">Français</option>
              <option value="es">Español</option>
              <option value="it">Italiano</option>
              <option value="pt">Português</option>
              <option value="nl">Nederlands</option>
              <option value="sv">Svenska</option>
              <option value="da">Dansk</option>
              <option value="no">Norsk</option>
              <option value="fi">Suomi</option>
              <option value="pl">Polski</option>
              <option value="cs">Čeština</option>
              <option value="tr">Türkçe</option>
              <option value="ru">Русский</option>
              <option value="ja">日本語</option>
              <option value="zh">中文</option>
              <option value="ko">한국어</option>
              <option value="ar">العربية</option>
              <option value="hi">हिन्दी</option>
            </select>
            <p className="text-[10px] text-muted mt-1">Auto-detect outputs in the same language as the clip</p>
          </div>
        </div>
      </div>

      {/* Upload Zone */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => {
          if (uploadState === "idle" || uploadState === "done") {
            resetUploadState();
            setSelectedFile(null);
            fileInputRef.current?.click();
          }
        }}
        className={`
          relative rounded-xl p-12 text-center transition-all duration-200 animate-slide-up overflow-hidden
          ${uploadState === "uploading" || uploadState === "processing" ? "cursor-default" : "cursor-pointer"}
          ${isDragging
            ? "bg-accent/5 scale-[1.01]"
            : uploadState === "done"
              ? "bg-success/5"
              : uploadState === "error"
                ? "bg-error/5"
                : "bg-surface hover:bg-surface-hover"
          }
        `}
        style={{ animationDelay: "0.1s" }}
      >
        {/* Corner brackets */}
        {["top-0 left-0", "top-0 right-0", "bottom-0 left-0", "bottom-0 right-0"].map((pos, i) => (
          <span
            key={i}
            className={`absolute ${pos} w-5 h-5 ${
              isDragging ? "border-accent" :
              uploadState === "done" ? "border-success/50" :
              uploadState === "error" ? "border-error/50" :
              "border-border-light"
            } ${
              i === 0 ? "border-t-2 border-l-2 rounded-tl" :
              i === 1 ? "border-t-2 border-r-2 rounded-tr" :
              i === 2 ? "border-b-2 border-l-2 rounded-bl" :
              "border-b-2 border-r-2 rounded-br"
            } transition-colors duration-200`}
          />
        ))}

        <input
          ref={fileInputRef}
          type="file"
          accept="video/*"
          onChange={handleFileSelect}
          className="hidden"
        />

        {uploadState === "idle" && !selectedFile && (
          <>
            <div className="w-12 h-12 rounded-xl bg-accent/10 border border-accent/20 flex items-center justify-center mx-auto mb-4">
              <svg className="w-6 h-6 text-accent-light" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
              </svg>
            </div>
            <p className="text-foreground font-medium mb-1">Drop your master file here</p>
            <p className="text-sm text-muted">or click to browse</p>
          </>
        )}

        {uploadState === "idle" && selectedFile && (
          <>
            <div className="w-12 h-12 rounded-xl bg-accent/10 border border-accent/20 flex items-center justify-center mx-auto mb-4">
              <svg className="w-6 h-6 text-accent-light" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25h-9A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z" />
              </svg>
            </div>
            <p className="text-foreground font-medium mb-1">{selectedFile.name}</p>
            <p className="text-sm text-muted">{formatFileSize(selectedFile.size)}</p>
          </>
        )}

        {(uploadState === "uploading" || uploadState === "processing") && (
          <>
            <div className="w-16 h-16 mx-auto mb-4 relative">
              <svg className="w-16 h-16 animate-spin text-accent/20" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" fill="none" />
              </svg>
              <svg className="w-16 h-16 absolute inset-0 animate-spin text-accent-light" viewBox="0 0 24 24" style={{ animationDuration: "1.5s" }}>
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" fill="none" strokeDasharray="15 47" strokeLinecap="round" />
              </svg>
            </div>
            <p className="text-foreground font-medium mb-1">
              {uploadState === "uploading" ? "Uploading to Gemini..." : "Processing video..."}
            </p>
            <div className="w-64 mx-auto mt-3 bg-border rounded-full h-1">
              <div
                className="bg-accent-light h-1 rounded-full transition-all duration-500"
                style={{ width: `${uploadProgress}%` }}
              />
            </div>
            <p className="tc text-xs text-muted mt-2">{uploadProgress}%</p>
          </>
        )}

        {uploadState === "done" && (
          <>
            <div className="w-12 h-12 rounded-xl bg-success/10 border border-success/20 flex items-center justify-center mx-auto mb-4">
              <svg className="w-6 h-6 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <p className="text-success font-medium mb-1">Upload complete</p>
            <p className="text-sm text-muted">Redirecting to deliverables...</p>
          </>
        )}

        {uploadState === "error" && (
          <>
            <div className="w-12 h-12 rounded-xl bg-error/10 border border-error/20 flex items-center justify-center mx-auto mb-4">
              <svg className="w-6 h-6 text-error" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
              </svg>
            </div>
            <p className="text-error font-medium mb-1">Upload failed</p>
            <p className="text-sm text-muted">{error}</p>
          </>
        )}
      </div>

      {/* Upload Button */}
      {selectedFile && uploadState === "idle" && (
        <div className="mt-4 flex flex-col gap-3 animate-fade-in">
          {!apiKey && (
            <p className="text-xs text-warning bg-warning/5 border border-warning/20 rounded-lg px-4 py-2.5">
              No API key configured. Go to Settings to add your Gemini API key before uploading.
            </p>
          )}
          <div className="flex gap-3">
            <button
              onClick={handleUpload}
              disabled={!apiKey}
              className="flex-1 px-6 py-3 bg-accent hover:bg-accent-light disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg font-medium transition-colors glow-accent"
            >
              Upload & Process
            </button>
            <button
              onClick={() => {
                setSelectedFile(null);
                if (fileInputRef.current) fileInputRef.current.value = "";
              }}
              className="px-6 py-3 bg-surface border border-border hover:border-border-light text-foreground rounded-lg font-medium transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {uploadState === "done" && (
        <div className="mt-4 flex gap-3 animate-fade-in">
          <button
            onClick={() => {
              resetUploadState();
              setSelectedFile(null);
              if (fileInputRef.current) fileInputRef.current.value = "";
            }}
            className="flex-1 px-6 py-3 bg-accent hover:bg-accent-light text-white rounded-lg font-medium transition-colors"
          >
            Upload New File
          </button>
        </div>
      )}

      {uploadState === "error" && (
        <div className="mt-4 flex gap-3">
          <button
            onClick={() => {
              resetUploadState();
              setLocalError(null);
            }}
            className="flex-1 px-6 py-3 bg-accent hover:bg-accent-light text-white rounded-lg font-medium transition-colors"
          >
            Try Again
          </button>
        </div>
      )}
    </div>
  );
}
