import {
  ShotEntry,
  DialogueEntry,
  GraphicsEntry,
  Synopses,
  TalentBio,
  FaunaEntry,
  IUCN_LABELS,
  IUCNStatus,
  Deliverables,
} from "./types";

function escapeCsv(value: string | undefined | null): string {
  const v = value ?? "";
  // Force-quote timecodes (HH:MM:SS:FF) so spreadsheet apps treat them as
  // plain text instead of splitting at the last colon.
  if (v.includes(",") || v.includes('"') || v.includes("\n") || /\d:\d/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

function toCsvRow(values: string[]): string {
  return values.map(escapeCsv).join(",");
}

function downloadCsv(filename: string, content: string) {
  const blob = new Blob(["\ufeff" + content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function exportShotList(shots: ShotEntry[], projectName: string) {
  const header = toCsvRow([
    "Shot #",
    "TC In",
    "TC Out",
    "Duration",
    "Scene Type",
    "Camera Movement",
    "Description",
    "Notes",
  ]);
  const rows = shots.map((s) =>
    toCsvRow([
      String(s.shotNumber),
      s.tcIn,
      s.tcOut,
      s.duration,
      s.sceneType,
      s.cameraMovement,
      s.description,
      s.notes,
    ])
  );
  downloadCsv(`${projectName}_shot_list.csv`, [header, ...rows].join("\n"));
}

export function exportDialogueList(entries: DialogueEntry[], projectName: string) {
  const header = toCsvRow([
    "TC In",
    "TC Out",
    "Speaker",
    "Dialogue",
    "Narration",
    "Language",
    "Notes",
  ]);
  const rows = entries.map((e) =>
    toCsvRow([
      e.tcIn,
      e.tcOut,
      e.speaker,
      e.dialogue,
      e.isNarration ? "YES" : "NO",
      e.language,
      e.notes,
    ])
  );
  downloadCsv(`${projectName}_dialogue_list.csv`, [header, ...rows].join("\n"));
}

export function exportGraphicsList(entries: GraphicsEntry[], projectName: string) {
  const header = toCsvRow([
    "TC In",
    "TC Out",
    "Type",
    "Content",
    "Position",
    "Notes",
  ]);
  const rows = entries.map((e) =>
    toCsvRow([
      e.tcIn,
      e.tcOut,
      e.graphicType,
      e.content,
      e.position,
      e.notes,
    ])
  );
  downloadCsv(`${projectName}_graphics_log.csv`, [header, ...rows].join("\n"));
}

export function exportSynopses(synopses: Synopses, projectName: string) {
  const content = [
    `LOGLINE`,
    synopses.logline,
    ``,
    `SHORT SYNOPSIS`,
    synopses.shortSynopsis,
    ``,
    `MEDIUM SYNOPSIS`,
    synopses.mediumSynopsis,
    ``,
    `LONG SYNOPSIS`,
    synopses.longSynopsis,
  ].join("\n");
  const blob = new Blob([content], { type: "text/plain;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${projectName}_synopses.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

export function exportTalentBios(bios: TalentBio[], projectName: string) {
  const header = toCsvRow([
    "Name",
    "Role",
    "First Appearance",
    "Bio",
    "All Appearances",
  ]);
  const rows = bios.map((b) =>
    toCsvRow([
      b.name,
      b.role,
      b.firstAppearance,
      b.bio,
      b.appearances.join("; "),
    ])
  );
  downloadCsv(`${projectName}_talent_bios.csv`, [header, ...rows].join("\n"));
}

export function exportFaunaLog(entries: FaunaEntry[], projectName: string) {
  const header = toCsvRow([
    "TC In",
    "TC Out",
    "Common Name",
    "Scientific Name",
    "IUCN Status",
    "IUCN Label",
    "Confidence",
    "Notes",
  ]);
  const rows = entries.map((e) =>
    toCsvRow([
      e.tcIn,
      e.tcOut,
      e.commonName,
      e.scientificName,
      e.iucnStatus,
      IUCN_LABELS[e.iucnStatus as IUCNStatus] || e.iucnStatus,
      `${Math.round(e.confidence * 100)}%`,
      e.notes,
    ])
  );
  downloadCsv(`${projectName}_fauna_log.csv`, [header, ...rows].join("\n"));
}

/** Returns true if any deliverable has data ready to export. */
export function hasAnyDeliverables(d: Deliverables): boolean {
  return (
    d.shotList.length > 0 ||
    d.dialogueList.length > 0 ||
    d.graphicsList.length > 0 ||
    d.synopses !== null ||
    d.talentBios.length > 0 ||
    d.faunaLog.length > 0
  );
}
