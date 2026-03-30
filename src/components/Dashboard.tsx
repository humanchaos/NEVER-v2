"use client";

import { ActivePanel } from "@/app/page";
import { useStore, store, createEmptyProject } from "@/lib/store";
import { formatFileSize, formatDuration } from "@/lib/timecode";
import { ANALYSIS_LABELS, AnalysisType, Project, AnalysisJob } from "@/lib/types";
import { useState } from "react";

interface DashboardProps {
  onNavigate: (panel: ActivePanel) => void;
}

export default function Dashboard({ onNavigate }: DashboardProps) {
  const project = useStore((s) => s.project);
  const apiKey = useStore((s) => s.apiKey);
  const jobs = useStore((s) => s.jobs);

  if (!apiKey) {
    return <WelcomeScreen onNavigate={onNavigate} />;
  }

  if (!project) {
    return <NewProjectScreen onNavigate={onNavigate} />;
  }

  return <ProjectDashboard project={project} jobs={jobs} onNavigate={onNavigate} />;
}

function WelcomeScreen({ onNavigate }: { onNavigate: (panel: ActivePanel) => void }) {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="max-w-lg text-center animate-fade-in">
        <div className="w-16 h-16 rounded-2xl bg-accent/10 border border-accent/20 flex items-center justify-center mx-auto mb-6">
          <svg className="w-8 h-8 text-accent-light" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25h-9A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z" />
          </svg>
        </div>
        <div className="mb-2 text-xs tracking-[0.25em] uppercase text-accent font-medium">Film Deliverables</div>
        <h2 className="text-3xl font-bold mb-3 tracking-tight">Welcome to NEVER</h2>
        <p className="text-muted-light mb-8 leading-relaxed text-sm">
          AI-powered broadcast deliverables for post-production professionals.
          Upload your master file and generate frame-accurate shot lists,
          dialogue transcripts, graphics logs, and more.
        </p>
        <button
          onClick={() => onNavigate("settings")}
          className="px-6 py-3 bg-accent hover:bg-accent-light text-white rounded-lg font-medium transition-colors glow-accent"
        >
          Connect API Key
        </button>
        <div className="mt-10 grid grid-cols-3 gap-3 text-left">
          {[
            { label: "Shot List", desc: "Frame-accurate IN/OUT timecodes with scene type and camera movement" },
            { label: "Fauna ID", desc: "Species identification with IUCN conservation status tags" },
            { label: "Talent Bios", desc: "Contributor profiles with first-appearance timecodes" },
          ].map((item) => (
            <div key={item.label} className="p-3 bg-surface border border-border rounded-lg">
              <p className="text-xs font-semibold text-accent-light mb-1">{item.label}</p>
              <p className="text-[10px] text-muted leading-relaxed">{item.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function NewProjectScreen({ onNavigate }: { onNavigate: (panel: ActivePanel) => void }) {
  const [name, setName] = useState("");

  const handleCreate = () => {
    if (!name.trim()) return;
    const project = createEmptyProject(name.trim());
    store.setProject(project);
  };

  return (
    <div className="flex items-center justify-center h-full">
      <div className="max-w-md w-full animate-fade-in">
        <div className="mb-1 text-xs tracking-[0.25em] uppercase text-accent font-medium">New Project</div>
        <h2 className="text-2xl font-bold mb-2 tracking-tight">Name Your Edit</h2>
        <p className="text-muted text-sm mb-8">Create a project to start generating deliverables.</p>

        <div className="space-y-3">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            placeholder='e.g. "Alpine Wildlife S01E03"'
            className="w-full px-4 py-3 bg-surface border border-border rounded-lg text-foreground placeholder:text-muted/50 focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-all text-sm"
            autoFocus
          />
          <button
            onClick={handleCreate}
            disabled={!name.trim()}
            className="w-full px-6 py-3 bg-accent hover:bg-accent-light disabled:opacity-30 disabled:cursor-not-allowed text-white rounded-lg font-medium transition-colors glow-accent text-sm"
          >
            Create Project
          </button>
        </div>
      </div>
    </div>
  );
}

function ProjectDashboard({
  project,
  jobs,
  onNavigate,
}: {
  project: Project;
  jobs: AnalysisJob[];
  onNavigate: (panel: ActivePanel) => void;
}) {
  const deliverables = project.deliverables;
  const hasVideo = !!project.videoFile;

  const stats = [
    { label: "Shots", count: deliverables.shotList.length, type: "shot_list" as AnalysisType },
    { label: "Dialogue", count: deliverables.dialogueList.length, type: "dialogue_list" as AnalysisType },
    { label: "Graphics", count: deliverables.graphicsList.length, type: "graphics_list" as AnalysisType },
    { label: "Talent", count: deliverables.talentBios.length, type: "talent_bios" as AnalysisType },
    { label: "Fauna", count: deliverables.faunaLog.length, type: "fauna_log" as AnalysisType },
  ];

  return (
    <div className="p-8 max-w-5xl mx-auto">
      {/* Header */}
      <div className="mb-8 animate-fade-in">
        <h2 className="text-2xl font-bold">{project.name}</h2>
        <p className="text-muted-light text-sm mt-1">
          {project.settings.broadcaster} &middot; {project.settings.frameRate} fps
          {project.settings.dropFrame ? " (Drop-Frame)" : " (Non-Drop-Frame)"}
        </p>
      </div>

      {/* Video Info Card */}
      <div className="bg-surface border border-border rounded-xl p-6 mb-6 animate-slide-up">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className={`w-12 h-12 rounded-lg flex items-center justify-center ${hasVideo ? "bg-success/10 border border-success/20" : "bg-accent/10 border border-accent/20"}`}>
              <svg className={`w-6 h-6 ${hasVideo ? "text-success" : "text-accent-light"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                {hasVideo ? (
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                )}
              </svg>
            </div>
            <div>
              {hasVideo ? (
                <>
                  <p className="font-medium">{project.videoFile!.name}</p>
                  <p className="text-sm text-muted">
                    {formatFileSize(project.videoFile!.size)}
                    {project.videoFile!.duration ? ` / ${formatDuration(project.videoFile!.duration)}` : ""}
                  </p>
                </>
              ) : (
                <>
                  <p className="font-medium">No video uploaded</p>
                  <p className="text-sm text-muted">Upload a master file to begin analysis</p>
                </>
              )}
            </div>
          </div>
          <button
            onClick={() => onNavigate("upload")}
            className="px-4 py-2 bg-accent hover:bg-accent-light text-white text-sm rounded-lg font-medium transition-colors"
          >
            {hasVideo ? "Replace Video" : "Upload Video"}
          </button>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-5 gap-3 mb-6">
        {stats.map((stat, i) => (
          <button
            key={stat.type}
            onClick={() => stat.count > 0 && onNavigate("deliverables")}
            className={`bg-surface border rounded-xl p-4 text-left transition-all animate-slide-up group ${
              stat.count > 0 ? "border-border hover:border-accent/30 hover:bg-accent/5 cursor-pointer" : "border-border cursor-default"
            }`}
            style={{ animationDelay: `${i * 0.05}s` }}
          >
            <p className={`text-3xl font-bold tabular-nums ${stat.count > 0 ? "text-foreground" : "text-muted/40"}`}>{stat.count}</p>
            <p className="text-[10px] text-muted uppercase tracking-wider mt-2">{stat.label}</p>
          </button>
        ))}
      </div>

      {/* Active Jobs */}
      {jobs.length > 0 && (
        <div className="bg-surface border border-border rounded-xl p-6 mb-6">
          <h3 className="text-sm font-semibold text-muted-light mb-4 uppercase tracking-wider">Active Jobs</h3>
          <div className="space-y-3">
            {jobs.map((job) => (
              <div key={job.id} className="flex items-center gap-4">
                <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                  job.status === "completed" ? "bg-success" :
                  job.status === "error" ? "bg-error" :
                  job.status === "processing" ? "bg-accent-light animate-pulse-ring" :
                  "bg-muted"
                }`} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{ANALYSIS_LABELS[job.type]}</p>
                  {job.error && <p className="text-xs text-error truncate">{job.error}</p>}
                </div>
                <span className="text-xs text-muted capitalize">{job.status}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Quick Actions */}
      {hasVideo && (
        <div className="bg-surface border border-border rounded-xl p-6 animate-slide-up" style={{ animationDelay: "0.3s" }}>
          <h3 className="text-sm font-semibold text-muted-light mb-4 uppercase tracking-wider">Quick Actions</h3>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => onNavigate("deliverables")}
              className="px-4 py-2 bg-accent hover:bg-accent-light text-white text-sm rounded-lg font-medium transition-colors"
            >
              Generate Deliverables
            </button>
            <button
              onClick={() => onNavigate("deliverables")}
              className="px-4 py-2 bg-surface-hover border border-border hover:border-border-light text-foreground text-sm rounded-lg font-medium transition-colors"
            >
              View Results
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
