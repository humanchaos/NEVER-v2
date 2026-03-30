"use client";

import { useState, useEffect } from "react";
import { useStore, store } from "@/lib/store";
import { FrameRate, FRAME_RATES, Broadcaster, BROADCASTERS } from "@/lib/types";

export default function SettingsPanel() {
  const apiKey = useStore((s) => s.apiKey);
  const project = useStore((s) => s.project);
  const [keyInput, setKeyInput] = useState(apiKey);
  const [showKey, setShowKey] = useState(false);

  // Keep input in sync if the store hydrates after initial render
  // (e.g., localStorage key loads asynchronously on first mount)
  useEffect(() => {
    setKeyInput((prev) => (prev === "" && apiKey !== "" ? apiKey : prev));
  }, [apiKey]);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const handleSaveKey = () => {
    store.setApiKey(keyInput.trim());
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleTestKey = async () => {
    if (!keyInput.trim()) return;
    setTesting(true);
    setTestResult(null);

    try {
      const { GoogleGenAI } = await import("@google/genai");
      const ai = new GoogleGenAI({ apiKey: keyInput.trim() });
      const result = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: "Say 'API key is valid' in exactly those words.",
        config: { thinkingConfig: { thinkingBudget: 0 }, maxOutputTokens: 20 },
      });
      const text = result.text ?? "";
      setTestResult({ ok: true, message: `Connected successfully. Response: "${text.slice(0, 80)}"` });
    } catch (err) {
      setTestResult({
        ok: false,
        message: err instanceof Error ? err.message : "Connection failed",
      });
    } finally {
      setTesting(false);
    }
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

  return (
    <div className="p-8 max-w-2xl mx-auto">
      <div className="mb-8 animate-fade-in">
        <div className="text-xs tracking-[0.25em] uppercase text-accent font-medium mb-1">Configuration</div>
        <h2 className="text-2xl font-bold tracking-tight">Settings</h2>
        <p className="text-muted text-sm mt-1">API key and project defaults.</p>
      </div>

      {/* API Key Section */}
      <div className="bg-surface border border-border rounded-xl p-6 mb-6 animate-slide-up">
        <h3 className="text-[10px] font-semibold text-muted uppercase tracking-[0.2em] mb-4">Gemini API Key</h3>
        <div className="space-y-4">
          <div className="relative">
            <input
              type={showKey ? "text" : "password"}
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder="Enter your Google Gemini API key..."
              className="w-full px-4 py-3 pr-20 bg-background border border-border rounded-lg text-foreground placeholder:text-muted focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-all font-mono text-sm"
            />
            <button
              onClick={() => setShowKey(!showKey)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted hover:text-foreground transition-colors"
            >
              {showKey ? "Hide" : "Show"}
            </button>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleSaveKey}
              disabled={!keyInput.trim()}
              className="px-4 py-2 bg-accent hover:bg-accent-light disabled:bg-border disabled:text-muted text-white text-sm rounded-lg font-medium transition-colors"
            >
              {saved ? "Saved!" : "Save Key"}
            </button>
            <button
              onClick={handleTestKey}
              disabled={!keyInput.trim() || testing}
              className="px-4 py-2 bg-surface-hover border border-border hover:border-border-light disabled:opacity-50 text-foreground text-sm rounded-lg font-medium transition-colors"
            >
              {testing ? "Testing..." : "Test Connection"}
            </button>
          </div>
          {testResult && (
            <div className={`text-xs p-3 rounded-lg border ${
              testResult.ok
                ? "bg-success/5 border-success/20 text-success"
                : "bg-error/5 border-error/20 text-error"
            }`}>
              {testResult.message}
            </div>
          )}
          <p className="text-xs text-muted">
            Your API key is stored locally in your browser and sent directly to Google&apos;s API.
            It is never stored on any server.
          </p>
        </div>
      </div>

      {/* Project Defaults */}
      {project && (
        <div className="bg-surface border border-border rounded-xl p-6 mb-6 animate-slide-up" style={{ animationDelay: "0.1s" }}>
          <h3 className="text-[10px] font-semibold text-muted uppercase tracking-[0.2em] mb-4">Project Defaults</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-muted mb-1.5">Project Name</label>
              <input
                type="text"
                value={project.name}
                onChange={(e) => store.updateProject({ name: e.target.value })}
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm text-foreground focus:outline-none focus:border-accent"
              />
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
      )}

      {/* Danger Zone */}
      {project && (
        <div className="bg-surface border border-error/20 rounded-xl p-6 animate-slide-up" style={{ animationDelay: "0.2s" }}>
          <h3 className="text-[10px] font-semibold text-error uppercase tracking-[0.2em] mb-4">Danger Zone</h3>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-foreground font-medium">Reset Project</p>
              <p className="text-xs text-muted mt-0.5">Delete all deliverables and start fresh.</p>
            </div>
            <button
              onClick={() => {
                if (confirm("Are you sure? This will delete all generated deliverables.")) {
                  store.updateDeliverables({
                    shotList: [],
                    dialogueList: [],
                    graphicsList: [],
                    synopses: null,
                    talentBios: [],
                    faunaLog: [],
                  });
                }
              }}
              className="px-4 py-2 bg-error/10 border border-error/20 hover:bg-error/20 text-error text-sm rounded-lg font-medium transition-colors"
            >
              Reset Deliverables
            </button>
          </div>
          <div className="flex items-center justify-between mt-4 pt-4 border-t border-error/10">
            <div>
              <p className="text-sm text-foreground font-medium">Delete Project</p>
              <p className="text-xs text-muted mt-0.5">Remove the entire project and all data.</p>
            </div>
            <button
              onClick={() => {
                if (confirm("Are you sure? This will permanently delete the project.")) {
                  store.setProject(null);
                  store.setJobs([]);
                }
              }}
              className="px-4 py-2 bg-error/10 border border-error/20 hover:bg-error/20 text-error text-sm rounded-lg font-medium transition-colors"
            >
              Delete Project
            </button>
          </div>
        </div>
      )}

      {/* About Section */}
      <div className="mt-6 text-center animate-fade-in" style={{ animationDelay: "0.3s" }}>
        <p className="text-[10px] text-muted/50 tracking-[0.15em] uppercase">NEVER — Film Deliverables &middot; Gemini 2.5 Flash</p>
        <p className="text-[10px] text-muted/60 tracking-[0.1em] mt-0.5 font-mono">
          v{process.env.NEXT_PUBLIC_APP_VERSION ?? "—"} &middot; {process.env.NEXT_PUBLIC_BUILD_TIME ? new Date(process.env.NEXT_PUBLIC_BUILD_TIME).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "local"}
        </p>
      </div>
    </div>
  );
}
