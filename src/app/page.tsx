"use client";

import { useState, useCallback, useEffect } from "react";
import Sidebar from "@/components/Sidebar";
import Dashboard from "@/components/Dashboard";
import UploadPanel from "@/components/UploadPanel";
import DeliverablesPanel from "@/components/DeliverablesPanel";
import SettingsPanel from "@/components/SettingsPanel";
import { useStore, hydrateStore } from "@/lib/store";

export type ActivePanel = "dashboard" | "upload" | "deliverables" | "settings";

export default function Home() {
  // Render nothing on the server / during hydration, then mount the real app client-side.
  // This avoids ALL hydration mismatches (localStorage state, etc.) that cause React #185.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    hydrateStore();
    setMounted(true);
  }, []);

  if (!mounted) {
    // This skeleton matches on both server and client during hydration → no mismatch
    return (
      <div className="flex h-screen overflow-hidden">
        <div className="w-64 h-full bg-surface border-r border-border shrink-0" />
        <div className="flex-1" />
      </div>
    );
  }

  return <App />;
}

function App() {
  const [activePanel, setActivePanel] = useState<ActivePanel>("dashboard");
  const project = useStore((s) => s.project);
  const apiKey = useStore((s) => s.apiKey);

  const navigateTo = useCallback((panel: ActivePanel) => {
    setActivePanel(panel);
  }, []);

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar activePanel={activePanel} onNavigate={navigateTo} hasProject={!!project} hasApiKey={!!apiKey} />
      <main className="flex-1 overflow-y-auto">
        {activePanel === "dashboard" && (
          <Dashboard onNavigate={navigateTo} />
        )}
        {activePanel === "upload" && (
          <UploadPanel onNavigate={navigateTo} />
        )}
        {activePanel === "deliverables" && (
          <DeliverablesPanel />
        )}
        {activePanel === "settings" && (
          <SettingsPanel />
        )}
      </main>
    </div>
  );
}
