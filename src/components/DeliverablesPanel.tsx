"use client";

import { useState, useCallback, useEffect } from "react";
import { useStore, store, runAnalysis as storeRunAnalysis, getAnalysisState, subscribeAnalysis, cancelAnalysis, cancelAllAnalyses } from "@/lib/store";
import {
  AnalysisType,
  ANALYSIS_LABELS,
  IUCN_LABELS,
  IUCN_COLORS,
  IUCNStatus,
  ShotEntry,
  DialogueEntry,
  GraphicsEntry,
  TalentBio,
  FaunaEntry,
  Synopses,
  FrameRate,
} from "@/lib/types";
import {
  exportShotList,
  exportDialogueList,
  exportGraphicsList,
  exportSynopses,
  exportTalentBios,
  exportFaunaLog,
  hasAnyDeliverables,
} from "@/lib/export";
let industryExportsCache: typeof import("@/lib/export-industry") | null = null;
async function getIndustryExports() {
  if (industryExportsCache) return industryExportsCache;
  industryExportsCache = await import(/* webpackChunkName: "export-industry" */ "@/lib/export-industry");
  return industryExportsCache;
}
import Thumbnail from "./Thumbnail";
import EditableField from "./EditableField";

const TABS: { id: AnalysisType; label: string; short: string }[] = [
  { id: "shot_list", label: "Shot List", short: "Shots" },
  { id: "dialogue_list", label: "Dialogue List", short: "Dialogue" },
  { id: "graphics_list", label: "Graphics Log", short: "Graphics" },
  { id: "synopses", label: "Synopses", short: "Synopses" },
  { id: "talent_bios", label: "Talent Bios", short: "Talent" },
  { id: "fauna_log", label: "Fauna ID", short: "Fauna" },
];

// Human-readable action labels shown in the progress strip
const ANALYSIS_ACTION_LABELS: Record<AnalysisType, string> = {
  shot_list: "Creating Shot List",
  dialogue_list: "Analysing Dialogue",
  graphics_list: "Logging Graphics",
  synopses: "Writing Synopses",
  talent_bios: "Identifying Talent",
  fauna_log: "Identifying Fauna",
};

// ─── Helper: update a single entry in an array by id ──────────────
function updateEntry<T extends { id: string }>(
  list: T[],
  id: string,
  updates: Partial<T>
): T[] {
  return list.map((item) => (item.id === id ? { ...item, ...updates } : item));
}

export default function DeliverablesPanel() {
  const project = useStore((s) => s.project);
  const apiKey = useStore((s) => s.apiKey);
  const [activeTab, setActiveTab] = useState<AnalysisType>("shot_list");
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [exportAllMenuOpen, setExportAllMenuOpen] = useState(false);

  // Analysis state lives in the store — survives navigation away from this panel
  const [analysisState, setAnalysisState] = useState(getAnalysisState);
  useEffect(() => {
    setAnalysisState(getAnalysisState());
    const unsub = subscribeAnalysis(() => setAnalysisState(getAnalysisState()));
    return () => { unsub(); };
  }, []);
  const { analyzing, errors, progress } = analysisState;

  // Derived progress values for the unified strip
  const runningTypes = TABS.map((t) => t.id).filter((t) => analyzing[t]);
  const anyAnalyzing = runningTypes.length > 0;
  const overallPct = anyAnalyzing
    ? Math.round(
        runningTypes.reduce((sum, t) => {
          const p = progress[t];
          return sum + (p ? Math.min((p.currentMin / p.totalMin) * 100, 95) : 5);
        }, 0) / runningTypes.length
      )
    : 0;
  const progressLabel =
    runningTypes.length === 1
      ? ANALYSIS_ACTION_LABELS[runningTypes[0]]
      : `Analysing ${runningTypes.length} modules`;


  const runAnalysis = useCallback((type: AnalysisType) => {
    storeRunAnalysis(type);
  }, []);

  const exportAllCsv = useCallback(() => {
    if (!project) return;
    const name = project.name.replace(/[^a-zA-Z0-9]/g, "_");
    const d = project.deliverables;
    if (d.shotList.length > 0) exportShotList(d.shotList, name);
    if (d.dialogueList.length > 0) exportDialogueList(d.dialogueList, name);
    if (d.graphicsList.length > 0) exportGraphicsList(d.graphicsList, name);
    if (d.synopses) exportSynopses(d.synopses, name);
    if (d.talentBios.length > 0) exportTalentBios(d.talentBios, name);
    if (d.faunaLog.length > 0) exportFaunaLog(d.faunaLog, name);
  }, [project]);

  const runAllAnalyses = useCallback(() => {
    const types: AnalysisType[] = [
      "shot_list", "dialogue_list", "graphics_list", "synopses", "talent_bios", "fauna_log",
    ];
    // Fire all analyses in parallel — each type is independent.
    // runAnalysis already guards against double-runs with _analyzing map.
    types.forEach((type) => storeRunAnalysis(type));
  }, []);

  const handleExport = useCallback(
    async (type: AnalysisType, format: "csv" | "pdf" | "docx") => {
      if (!project) return;
      const name = project.name.replace(/[^a-zA-Z0-9]/g, "_");
      const d = project.deliverables;

      if (format === "csv") {
        switch (type) {
          case "shot_list": exportShotList(d.shotList, name); break;
          case "dialogue_list": exportDialogueList(d.dialogueList, name); break;
          case "graphics_list": exportGraphicsList(d.graphicsList, name); break;
          case "synopses": if (d.synopses) exportSynopses(d.synopses, name); break;
          case "talent_bios": exportTalentBios(d.talentBios, name); break;
          case "fauna_log": exportFaunaLog(d.faunaLog, name); break;
        }
      } else if (format === "pdf") {
        const ex = await getIndustryExports();
        switch (type) {
          case "shot_list": await ex.exportShotListPdf(d.shotList, name); break;
          case "dialogue_list": await ex.exportDialogueListPdf(d.dialogueList, name); break;
          case "graphics_list": await ex.exportGraphicsListPdf(d.graphicsList, name); break;
          case "synopses": if (d.synopses) await ex.exportSynopsesPdf(d.synopses, name); break;
          case "talent_bios": await ex.exportTalentBiosPdf(d.talentBios, name); break;
          case "fauna_log": await ex.exportFaunaLogPdf(d.faunaLog, name); break;
        }
      } else if (format === "docx") {
        const ex = await getIndustryExports();
        switch (type) {
          case "shot_list": await ex.exportShotListDocx(d.shotList, name); break;
          case "dialogue_list": await ex.exportDialogueListDocx(d.dialogueList, name); break;
          case "graphics_list": await ex.exportGraphicsListDocx(d.graphicsList, name); break;
          case "synopses": if (d.synopses) await ex.exportSynopsesDocx(d.synopses, name); break;
          case "talent_bios": await ex.exportTalentBiosDocx(d.talentBios, name); break;
          case "fauna_log": await ex.exportFaunaLogDocx(d.faunaLog, name); break;
        }
      }
      setExportMenuOpen(false);
    },
    [project]
  );

  // ─── Edit handlers ──────────────────────────────────────────────
  const editShot = useCallback(
    (id: string, updates: Partial<ShotEntry>) => {
      if (!project) return;
      store.updateDeliverables({
        shotList: updateEntry(project.deliverables.shotList, id, updates),
      });
    },
    [project]
  );

  const editDialogue = useCallback(
    (id: string, updates: Partial<DialogueEntry>) => {
      if (!project) return;
      store.updateDeliverables({
        dialogueList: updateEntry(project.deliverables.dialogueList, id, updates),
      });
    },
    [project]
  );

  const editGraphics = useCallback(
    (id: string, updates: Partial<GraphicsEntry>) => {
      if (!project) return;
      store.updateDeliverables({
        graphicsList: updateEntry(project.deliverables.graphicsList, id, updates),
      });
    },
    [project]
  );

  const editSynopses = useCallback(
    (updates: Partial<Synopses>) => {
      if (!project?.deliverables.synopses) return;
      store.updateDeliverables({
        synopses: { ...project.deliverables.synopses, ...updates },
      });
    },
    [project]
  );

  const editTalent = useCallback(
    (id: string, updates: Partial<TalentBio>) => {
      if (!project) return;
      store.updateDeliverables({
        talentBios: updateEntry(project.deliverables.talentBios, id, updates),
      });
    },
    [project]
  );

  const editFauna = useCallback(
    (id: string, updates: Partial<FaunaEntry>) => {
      if (!project) return;
      store.updateDeliverables({
        faunaLog: updateEntry(project.deliverables.faunaLog, id, updates),
      });
    },
    [project]
  );

  if (!project) return null;

  const hasVideo = !!project.videoFile;
  const deliverables = project.deliverables;
  const fr = project.settings.frameRate;

  const getCount = (type: AnalysisType): number => {
    switch (type) {
      case "shot_list": return deliverables.shotList.length;
      case "dialogue_list": return deliverables.dialogueList.length;
      case "graphics_list": return deliverables.graphicsList.length;
      case "synopses": return deliverables.synopses ? 1 : 0;
      case "talent_bios": return deliverables.talentBios.length;
      case "fauna_log": return deliverables.faunaLog.length;
    }
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-6 pt-6 pb-4 border-b border-border flex items-center justify-between">
        <div>
          <div className="text-[10px] tracking-[0.2em] uppercase text-accent font-medium mb-0.5">Deliverables</div>
          <h2 className="text-lg font-bold tracking-tight select-none">{project.name}</h2>
        </div>
        {hasVideo && (
          <div className="flex items-center gap-2">
            {hasAnyDeliverables(deliverables) && (
              <div className="relative">
                <button
                  onClick={() => setExportAllMenuOpen(!exportAllMenuOpen)}
                  className="px-3 py-2 bg-surface-hover border border-border hover:border-border-light text-foreground text-xs rounded-lg font-medium transition-colors flex items-center gap-1.5"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                  </svg>
                  Export All
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                  </svg>
                </button>
                {exportAllMenuOpen && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setExportAllMenuOpen(false)} />
                    <div className="absolute top-full right-0 mt-1 bg-surface border border-border rounded-lg shadow-xl z-20 min-w-[180px] py-1">
                      <div className="px-3 py-1.5 text-[10px] text-muted uppercase tracking-[0.15em] border-b border-border mb-1">All Deliverables</div>
                      <button
                        onClick={() => { exportAllCsv(); setExportAllMenuOpen(false); }}
                        className="w-full px-3 py-2 text-left text-xs text-foreground hover:bg-surface-hover transition-colors flex items-center gap-2"
                      >
                        <span className="w-10 text-[10px] text-muted font-mono">CSV</span>
                        All as Spreadsheets
                      </button>
                      <button
                        onClick={async () => {
                          setExportAllMenuOpen(false);
                          const ex = await getIndustryExports();
                          const d = deliverables;
                          const name = project.name.replace(/[^a-zA-Z0-9]/g, "_");
                          if (d.shotList.length > 0) await ex.exportShotListPdf(d.shotList, name);
                          if (d.dialogueList.length > 0) await ex.exportDialogueListPdf(d.dialogueList, name);
                          if (d.graphicsList.length > 0) await ex.exportGraphicsListPdf(d.graphicsList, name);
                          if (d.synopses) await ex.exportSynopsesPdf(d.synopses, name);
                          if (d.talentBios.length > 0) await ex.exportTalentBiosPdf(d.talentBios, name);
                          if (d.faunaLog.length > 0) await ex.exportFaunaLogPdf(d.faunaLog, name);
                        }}
                        className="w-full px-3 py-2 text-left text-xs text-foreground hover:bg-surface-hover transition-colors flex items-center gap-2"
                      >
                        <span className="w-10 text-[10px] text-muted font-mono">PDF</span>
                        All as Broadcast PDFs
                      </button>
                      <button
                        onClick={async () => {
                          setExportAllMenuOpen(false);
                          const ex = await getIndustryExports();
                          const d = deliverables;
                          const name = project.name.replace(/[^a-zA-Z0-9]/g, "_");
                          if (d.shotList.length > 0) await ex.exportShotListDocx(d.shotList, name);
                          if (d.dialogueList.length > 0) await ex.exportDialogueListDocx(d.dialogueList, name);
                          if (d.graphicsList.length > 0) await ex.exportGraphicsListDocx(d.graphicsList, name);
                          if (d.synopses) await ex.exportSynopsesDocx(d.synopses, name);
                          if (d.talentBios.length > 0) await ex.exportTalentBiosDocx(d.talentBios, name);
                          if (d.faunaLog.length > 0) await ex.exportFaunaLogDocx(d.faunaLog, name);
                        }}
                        className="w-full px-3 py-2 text-left text-xs text-foreground hover:bg-surface-hover transition-colors flex items-center gap-2"
                      >
                        <span className="w-10 text-[10px] text-muted font-mono">DOCX</span>
                        All as Word Documents
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
            {anyAnalyzing && (
              <button
                onClick={cancelAllAnalyses}
                className="px-3 py-2 text-xs text-red-400 hover:text-red-300 border border-red-900/40 hover:border-red-700 rounded-lg transition-colors"
              >
                Cancel All
              </button>
            )}
            <button
              onClick={runAllAnalyses}
              disabled={anyAnalyzing}
              className="px-4 py-2 bg-accent hover:bg-accent-light disabled:opacity-40 text-white text-xs rounded-lg font-medium transition-colors glow-accent tracking-wide"
            >
              {anyAnalyzing ? (
                <span className="flex items-center gap-2">
                  <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" fill="none" strokeDasharray="15 47" strokeLinecap="round" /></svg>
                  Analysing…
                </span>
              ) : "Generate All"}
            </button>
          </div>
        )}
      </div>

      {/* Unified Analysis Progress Strip */}
      {anyAnalyzing && (
        <div className="px-6 pt-3">
          <div className="bg-surface border border-border/60 rounded-lg px-4 py-3">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <svg className="w-3 h-3 animate-spin text-accent shrink-0" viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" fill="none" strokeDasharray="15 47" strokeLinecap="round" />
                </svg>
                <span className="text-xs font-medium text-foreground">{progressLabel}</span>
                {runningTypes.length > 1 && (
                  <div className="flex gap-1 ml-1">
                    {runningTypes.map((t) => (
                      <span key={t} className="text-[10px] text-accent/70 bg-accent/10 px-1.5 py-0.5 rounded">
                        {TABS.find((tab) => tab.id === t)?.short}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs font-mono tabular-nums text-accent">{overallPct}%</span>
                <button
                  onClick={cancelAllAnalyses}
                  className="text-[11px] text-red-400 hover:text-red-300 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
            <div className="h-1 bg-border rounded-full overflow-hidden">
              <div
                className="h-full bg-accent rounded-full transition-all duration-700"
                style={{ width: `${overallPct}%` }}
              />
            </div>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="px-6 pt-3 pb-0">
        <div className="flex border-b border-border">
          {TABS.map((tab) => {
            const count = getCount(tab.id);
            const isActive = activeTab === tab.id;
            const isRunning = analyzing[tab.id];
            const isDone = !isRunning && count > 0;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`
                  relative px-4 py-2.5 text-xs font-medium transition-all border-b-2 -mb-px
                  ${isActive
                    ? "border-accent text-accent-light"
                    : isDone
                    ? "border-emerald-600/50 text-emerald-400 hover:text-emerald-300"
                    : "border-transparent text-muted hover:text-muted-light hover:border-border"
                  }
                `}
              >
                <span>{tab.short}</span>
                {count > 0 && (
                  <span className={`ml-1.5 text-[10px] tabular-nums ${isActive ? "text-accent/70" : "text-muted/50"}`}>
                    {count}
                  </span>
                )}
                {isRunning && (
                  <span className="absolute top-2 right-1 w-1.5 h-1.5 rounded-full bg-accent-light animate-pulse" />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {!hasVideo ? (
          <div className="flex items-center justify-center h-64 text-center">
            <div>
              <p className="text-muted-light mb-2">No video uploaded yet</p>
              <p className="text-sm text-muted">Upload a video file to start generating deliverables.</p>
            </div>
          </div>
        ) : (
          <>
            {/* Action bar */}
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => runAnalysis(activeTab)}
                  disabled={analyzing[activeTab]}
                  className="px-3 py-1.5 bg-accent hover:bg-accent-light border border-accent/40 text-white text-xs rounded-lg font-medium transition-colors disabled:opacity-40 glow-accent"
                >
                  {analyzing[activeTab] ? (
                    <span className="flex items-center gap-1.5">
                      <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" fill="none" strokeDasharray="15 47" strokeLinecap="round" /></svg>
                      {ANALYSIS_ACTION_LABELS[activeTab]}
                    </span>
                  ) : (
                    `Generate ${ANALYSIS_LABELS[activeTab]}`
                  )}
                </button>

                {analyzing[activeTab] && (
                  <button
                    onClick={() => cancelAnalysis(activeTab)}
                    className="px-2 py-1.5 text-xs text-red-400 hover:text-red-300 border border-red-900/40 hover:border-red-700 rounded-lg transition-colors"
                  >
                    Cancel
                  </button>
                )}

                {/* Export dropdown */}
                {getCount(activeTab) > 0 && (
                  <div className="relative">
                    <button
                      onClick={() => setExportMenuOpen(!exportMenuOpen)}
                      className="px-3 py-1.5 bg-surface-hover border border-border text-foreground text-xs rounded-md font-medium hover:border-border-light transition-colors flex items-center gap-1.5"
                    >
                      Export
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                      </svg>
                    </button>
                    {exportMenuOpen && (
                      <>
                        <div className="fixed inset-0 z-10" onClick={() => setExportMenuOpen(false)} />
                        <div className="absolute top-full left-0 mt-1 bg-surface border border-border rounded-lg shadow-xl z-20 min-w-[160px] py-1">
                          <button
                            onClick={() => handleExport(activeTab, "csv")}
                            className="w-full px-3 py-2 text-left text-xs text-foreground hover:bg-surface-hover transition-colors flex items-center gap-2"
                          >
                            <span className="w-8 text-[10px] text-muted font-mono">CSV</span>
                            Spreadsheet
                          </button>
                          <button
                            onClick={() => handleExport(activeTab, "pdf")}
                            className="w-full px-3 py-2 text-left text-xs text-foreground hover:bg-surface-hover transition-colors flex items-center gap-2"
                          >
                            <span className="w-8 text-[10px] text-error font-mono">PDF</span>
                            Broadcast PDF
                          </button>
                          <button
                            onClick={() => handleExport(activeTab, "docx")}
                            className="w-full px-3 py-2 text-left text-xs text-foreground hover:bg-surface-hover transition-colors flex items-center gap-2"
                          >
                            <span className="w-8 text-[10px] text-info font-mono">DOCX</span>
                            Word Document
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-3">
                {getCount(activeTab) > 0 && (
                  <span className="text-[10px] text-muted italic">Click any field to edit</span>
                )}
                {errors[activeTab] && (
                  <p className="text-xs text-error">{errors[activeTab]}</p>
                )}
              </div>
            </div>

            {/* Tab Content */}
            {activeTab === "shot_list" && <ShotListView shots={deliverables.shotList} frameRate={fr} onEdit={editShot} />}
            {activeTab === "dialogue_list" && <DialogueListView entries={deliverables.dialogueList} frameRate={fr} onEdit={editDialogue} />}
            {activeTab === "graphics_list" && <GraphicsListView entries={deliverables.graphicsList} frameRate={fr} onEdit={editGraphics} />}
            {activeTab === "synopses" && <SynopsesView synopses={deliverables.synopses} onEdit={editSynopses} />}
            {activeTab === "talent_bios" && <TalentBiosView bios={deliverables.talentBios} frameRate={fr} onEdit={editTalent} />}
            {activeTab === "fauna_log" && <FaunaLogView entries={deliverables.faunaLog} frameRate={fr} onEdit={editFauna} />}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Sub-views (all editable) ─────────────────────────────────────

function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center h-48 text-center">
      <div>
        <div className="w-8 h-8 rounded-lg border border-border flex items-center justify-center mx-auto mb-3">
          <svg className="w-4 h-4 text-muted/50" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m6.75 12H9m1.5-12H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
          </svg>
        </div>
        <p className="text-muted text-xs">No {label} generated yet</p>
        <p className="text-[10px] text-muted/60 mt-1">Click Generate above to start</p>
      </div>
    </div>
  );
}

const PAGE_SIZE = 50;

function PaginationBar({ total, page, setPage }: { total: number; page: number; setPage: (p: number) => void }) {
  const totalPages = Math.ceil(total / PAGE_SIZE);
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-between py-3 border-t border-border mt-4">
      <span className="text-xs text-muted">
        Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
      </span>
      <div className="flex gap-1">
        <button onClick={() => setPage(0)} disabled={page === 0} className="px-2 py-1 text-xs rounded bg-surface-hover border border-border disabled:opacity-30 hover:border-border-light transition-colors">
          ««
        </button>
        <button onClick={() => setPage(page - 1)} disabled={page === 0} className="px-2 py-1 text-xs rounded bg-surface-hover border border-border disabled:opacity-30 hover:border-border-light transition-colors">
          ‹
        </button>
        <span className="px-3 py-1 text-xs text-muted-light">
          {page + 1} / {totalPages}
        </span>
        <button onClick={() => setPage(page + 1)} disabled={page >= totalPages - 1} className="px-2 py-1 text-xs rounded bg-surface-hover border border-border disabled:opacity-30 hover:border-border-light transition-colors">
          ›
        </button>
        <button onClick={() => setPage(totalPages - 1)} disabled={page >= totalPages - 1} className="px-2 py-1 text-xs rounded bg-surface-hover border border-border disabled:opacity-30 hover:border-border-light transition-colors">
          »»
        </button>
      </div>
    </div>
  );
}

function ShotListView({ shots, frameRate, onEdit }: { shots: ShotEntry[]; frameRate: FrameRate; onEdit: (id: string, u: Partial<ShotEntry>) => void }) {
  const [page, setPage] = useState(0);
  // Reset to first page when the list is replaced by a new analysis
  const totalPages = Math.ceil(shots.length / PAGE_SIZE);
  useEffect(() => { if (page >= totalPages && totalPages > 0) setPage(0); }, [totalPages, page]);

  if (shots.length === 0) return <EmptyState label="shots" />;

  const pageShots = shots.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div>
      <PaginationBar total={shots.length} page={page} setPage={setPage} />
      <div className="space-y-2">
        {pageShots.map((shot) => (
          <div key={shot.id} className="bg-surface border border-border rounded-lg p-4 flex gap-4">
            <Thumbnail timecode={shot.tcIn} frameRate={frameRate} />
            <div className="flex-1 min-w-0">
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center gap-3">
                  <span className="text-xs font-bold text-accent-light bg-accent/10 px-2 py-0.5 rounded">
                    #{shot.shotNumber}
                  </span>
                  <EditableField
                    value={shot.sceneType}
                    onSave={(v) => onEdit(shot.id, { sceneType: v })}
                    className="text-xs font-medium text-muted"
                  />
                  <EditableField
                    value={shot.cameraMovement}
                    onSave={(v) => onEdit(shot.id, { cameraMovement: v })}
                    className="text-xs text-muted"
                    placeholder="Camera movement"
                  />
                </div>
                <div className="flex gap-4 text-xs shrink-0">
                  <span className="text-muted">IN <span className="tc text-foreground">{shot.tcIn}</span></span>
                  <span className="text-muted">OUT <span className="tc text-foreground">{shot.tcOut}</span></span>
                  <span className="text-muted">DUR <span className="tc text-accent-light">{shot.duration}</span></span>
                </div>
              </div>
              <EditableField
                value={shot.description}
                onSave={(v) => onEdit(shot.id, { description: v })}
                tag="p"
                multiline
                className="text-sm text-muted-light leading-relaxed"
              />
              <EditableField
                value={shot.notes}
                onSave={(v) => onEdit(shot.id, { notes: v })}
                tag="p"
                className="text-xs text-muted mt-2 italic"
                placeholder="Add notes..."
              />
            </div>
          </div>
        ))}
      </div>
      <PaginationBar total={shots.length} page={page} setPage={setPage} />
    </div>
  );
}

function DialogueListView({ entries, frameRate, onEdit }: { entries: DialogueEntry[]; frameRate: FrameRate; onEdit: (id: string, u: Partial<DialogueEntry>) => void }) {
  const [page, setPage] = useState(0);
  const totalPages = Math.ceil(entries.length / PAGE_SIZE);
  useEffect(() => { if (page >= totalPages && totalPages > 0) setPage(0); }, [totalPages, page]);

  if (entries.length === 0) return <EmptyState label="dialogue entries" />;

  const pageEntries = entries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div>
      <PaginationBar total={entries.length} page={page} setPage={setPage} />
      <div className="space-y-2">
        {pageEntries.map((entry) => (
          <div key={entry.id} className="bg-surface border border-border rounded-lg p-4 flex gap-4">
          <Thumbnail timecode={entry.tcIn} frameRate={frameRate} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <EditableField
                  value={entry.speaker}
                  onSave={(v) => onEdit(entry.id, { speaker: v })}
                  className={`text-xs font-bold px-2 py-0.5 rounded ${
                    entry.isNarration ? "bg-info/10 text-info" : "bg-accent/10 text-accent-light"
                  }`}
                />
                {entry.isNarration && (
                  <span className="text-[10px] text-muted bg-surface-hover px-1.5 py-0.5 rounded uppercase">V/O</span>
                )}
              </div>
              <div className="flex gap-3 text-xs shrink-0">
                <span className="tc text-muted">{entry.tcIn}</span>
                <span className="text-muted/40">-</span>
                <span className="tc text-muted">{entry.tcOut}</span>
              </div>
            </div>
            <EditableField
              value={entry.dialogue}
              onSave={(v) => onEdit(entry.id, { dialogue: v })}
              tag="p"
              multiline
              className="text-sm text-foreground leading-relaxed"
            />
            <EditableField
              value={entry.notes}
              onSave={(v) => onEdit(entry.id, { notes: v })}
              tag="p"
              className="text-xs text-muted mt-2 italic"
              placeholder="Add notes..."
            />
          </div>
        </div>
      ))}
      </div>
      <PaginationBar total={entries.length} page={page} setPage={setPage} />
    </div>
  );
}

function GraphicsListView({ entries, frameRate, onEdit }: { entries: GraphicsEntry[]; frameRate: FrameRate; onEdit: (id: string, u: Partial<GraphicsEntry>) => void }) {
  const [page, setPage] = useState(0);
  const totalPages = Math.ceil(entries.length / PAGE_SIZE);
  useEffect(() => { if (page >= totalPages && totalPages > 0) setPage(0); }, [totalPages, page]);

  if (entries.length === 0) return <EmptyState label="graphics" />;

  const typeColors: Record<string, string> = {
    lower_third: "bg-info/10 text-info",
    title_card: "bg-accent/10 text-accent-light",
    subtitle: "bg-warning/10 text-warning",
    credit: "bg-success/10 text-success",
    other: "bg-surface-hover text-muted",
  };

  const pageEntries = entries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div>
      <PaginationBar total={entries.length} page={page} setPage={setPage} />
      <div className="space-y-2">
        {pageEntries.map((entry) => (
          <div key={entry.id} className="bg-surface border border-border rounded-lg p-4 flex gap-4">
          <Thumbnail timecode={entry.tcIn} frameRate={frameRate} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className={`text-xs font-medium px-2 py-0.5 rounded ${typeColors[entry.graphicType] || typeColors.other}`}>
                  {entry.graphicType.replace(/_/g, " ")}
                </span>
                <EditableField
                  value={entry.position}
                  onSave={(v) => onEdit(entry.id, { position: v })}
                  className="text-xs text-muted"
                  placeholder="Position"
                />
              </div>
              <div className="flex gap-3 text-xs shrink-0">
                <span className="tc text-muted">{entry.tcIn}</span>
                <span className="text-muted/40">-</span>
                <span className="tc text-muted">{entry.tcOut}</span>
              </div>
            </div>
            <EditableField
              value={entry.content}
              onSave={(v) => onEdit(entry.id, { content: v })}
              tag="p"
              className="text-sm text-foreground font-medium"
            />
            <EditableField
              value={entry.notes}
              onSave={(v) => onEdit(entry.id, { notes: v })}
              tag="p"
              className="text-xs text-muted mt-2 italic"
              placeholder="Add notes..."
            />
          </div>
        </div>
      ))}
      </div>
      <PaginationBar total={entries.length} page={page} setPage={setPage} />
    </div>
  );
}

function SynopsesView({ synopses, onEdit }: { synopses: Synopses | null; onEdit: (u: Partial<Synopses>) => void }) {
  if (!synopses) return <EmptyState label="synopses" />;

  const fields: { label: string; key: keyof Synopses }[] = [
    { label: "Logline", key: "logline" },
    { label: "Short Synopsis", key: "shortSynopsis" },
    { label: "Medium Synopsis", key: "mediumSynopsis" },
    { label: "Long Synopsis", key: "longSynopsis" },
  ];

  return (
    <div className="space-y-6 animate-fade-in">
      {fields.map((item) => (
        <div key={item.key} className="bg-surface border border-border rounded-lg p-5">
          <h4 className="text-xs font-semibold text-accent-light uppercase tracking-wider mb-3">{item.label}</h4>
          <EditableField
            value={synopses[item.key]}
            onSave={(v) => onEdit({ [item.key]: v })}
            tag="p"
            multiline
            className="text-sm text-muted-light leading-relaxed whitespace-pre-wrap"
          />
        </div>
      ))}
    </div>
  );
}

function TalentBiosView({ bios, frameRate, onEdit }: { bios: TalentBio[]; frameRate: FrameRate; onEdit: (id: string, u: Partial<TalentBio>) => void }) {
  if (bios.length === 0) return <EmptyState label="talent bios" />;

  return (
    <div className="space-y-3">
      {bios.map((bio, i) => (
        <div key={bio.id} className="bg-surface border border-border rounded-lg p-5 animate-fade-in" style={{ animationDelay: `${i * 0.03}s` }}>
          <div className="flex items-start justify-between mb-3">
            <div>
              <EditableField
                value={bio.name}
                onSave={(v) => onEdit(bio.id, { name: v })}
                tag="h4"
                className="font-semibold text-foreground"
              />
              <EditableField
                value={bio.role}
                onSave={(v) => onEdit(bio.id, { role: v })}
                tag="p"
                className="text-xs text-muted mt-0.5"
                placeholder="Role"
              />
            </div>
            <span className="text-xs text-muted shrink-0 ml-4">
              First: <span className="tc text-muted-light">{bio.firstAppearance}</span>
            </span>
          </div>
          <EditableField
            value={bio.bio}
            onSave={(v) => onEdit(bio.id, { bio: v })}
            tag="p"
            multiline
            className="text-sm text-muted-light leading-relaxed"
          />
          {bio.appearances.length > 1 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {bio.appearances.map((tc, j) => (
                <span key={j} className="tc text-[10px] text-muted bg-surface-hover border border-border px-1.5 py-0.5 rounded">
                  {tc}
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function FaunaLogView({ entries, frameRate, onEdit }: { entries: FaunaEntry[]; frameRate: FrameRate; onEdit: (id: string, u: Partial<FaunaEntry>) => void }) {
  const [page, setPage] = useState(0);
  const totalPages = Math.ceil(entries.length / PAGE_SIZE);
  useEffect(() => { if (page >= totalPages && totalPages > 0) setPage(0); }, [totalPages, page]);

  if (entries.length === 0) return <EmptyState label="fauna entries" />;

  const pageEntries = entries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div>
      <PaginationBar total={entries.length} page={page} setPage={setPage} />
      <div className="space-y-2">
        {pageEntries.map((entry) => (
          <div key={entry.id} className="bg-surface border border-border rounded-lg p-4 flex gap-4">
          <Thumbnail timecode={entry.tcIn} frameRate={frameRate} />
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between mb-2">
              <div className="flex items-center gap-2">
                <EditableField
                  value={entry.commonName}
                  onSave={(v) => onEdit(entry.id, { commonName: v })}
                  tag="h4"
                  className="font-semibold text-foreground text-sm"
                />
                <EditableField
                  value={entry.scientificName}
                  onSave={(v) => onEdit(entry.id, { scientificName: v })}
                  className="text-xs text-muted italic"
                  placeholder="Scientific name"
                />
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <span
                  className="text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider"
                  style={{
                    backgroundColor: `${IUCN_COLORS[entry.iucnStatus as IUCNStatus]}15`,
                    color: IUCN_COLORS[entry.iucnStatus as IUCNStatus],
                    border: `1px solid ${IUCN_COLORS[entry.iucnStatus as IUCNStatus]}30`,
                  }}
                >
                  {IUCN_LABELS[entry.iucnStatus as IUCNStatus] || entry.iucnStatus}
                </span>
                <span className="text-xs text-muted">
                  {Math.round(entry.confidence * 100)}% conf.
                </span>
              </div>
            </div>
            <div className="flex gap-3 text-xs mb-2">
              <span className="tc text-muted">{entry.tcIn}</span>
              <span className="text-muted/40">-</span>
              <span className="tc text-muted">{entry.tcOut}</span>
            </div>
            <EditableField
              value={entry.notes}
              onSave={(v) => onEdit(entry.id, { notes: v })}
              tag="p"
              className="text-xs text-muted-light leading-relaxed"
              placeholder="Add notes..."
            />
          </div>
        </div>
      ))}

      </div>
      <PaginationBar total={entries.length} page={page} setPage={setPage} />

      {/* IUCN Legend */}
      {entries.length > 0 && (
        <div className="mt-6 bg-surface border border-border rounded-lg p-4">
          <h4 className="text-xs font-semibold text-muted-light uppercase tracking-wider mb-3">IUCN Conservation Status Legend</h4>
          <div className="flex flex-wrap gap-2">
            {(Object.entries(IUCN_LABELS) as [IUCNStatus, string][]).map(([key, label]) => (
              <span
                key={key}
                className="text-[10px] px-2 py-0.5 rounded-full"
                style={{
                  backgroundColor: `${IUCN_COLORS[key]}10`,
                  color: IUCN_COLORS[key],
                  border: `1px solid ${IUCN_COLORS[key]}20`,
                }}
              >
                {key}: {label}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
