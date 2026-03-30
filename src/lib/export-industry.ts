/**
 * Industry-standard broadcast PDF and DOCX exports.
 * PDF: Uses jsPDF + autoTable for formatted, print-ready deliverables.
 * DOCX: Uses docx library for Word documents meeting PBS/BBC specs.
 */

import {
  ShotEntry,
  DialogueEntry,
  GraphicsEntry,
  Synopses,
  TalentBio,
  FaunaEntry,
  IUCN_LABELS,
  IUCNStatus,
} from "./types";

// ─── PDF Exports ──────────────────────────────────────────────────

async function makePdf() {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  return doc;
}

async function runAutoTable(doc: import("jspdf").jsPDF, opts: Record<string, unknown>) {
  const { autoTable } = await import("jspdf-autotable");
  autoTable(doc as unknown as Parameters<typeof autoTable>[0], opts as Parameters<typeof autoTable>[1]);
}

function pdfHeader(doc: import("jspdf").jsPDF, title: string, projectName: string) {
  doc.setFontSize(16);
  doc.setFont("helvetica", "bold");
  doc.text(title, 14, 15);
  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(120);
  doc.text(`Project: ${projectName}  |  Generated: ${new Date().toLocaleDateString()}  |  NEVER v3`, 14, 22);
  doc.setTextColor(0);
  return 28;
}

export async function exportShotListPdf(shots: ShotEntry[], projectName: string) {
  const doc = await makePdf();
  const startY = pdfHeader(doc, "SHOT LIST", projectName);

  await runAutoTable(doc, {
    startY,
    head: [["#", "TC In", "TC Out", "Duration", "Type", "Camera", "Description", "Notes"]],
    body: shots.map((s) => [
      s.shotNumber,
      s.tcIn,
      s.tcOut,
      s.duration,
      s.sceneType,
      s.cameraMovement,
      s.description,
      s.notes,
    ]),
    styles: { fontSize: 7, cellPadding: 2 },
    headStyles: { fillColor: [40, 40, 55], textColor: [200, 200, 220], fontSize: 7 },
    columnStyles: {
      0: { cellWidth: 10 },
      1: { cellWidth: 25, font: "courier" },
      2: { cellWidth: 25, font: "courier" },
      3: { cellWidth: 22, font: "courier" },
      4: { cellWidth: 22 },
      5: { cellWidth: 22 },
      6: { cellWidth: "auto" },
      7: { cellWidth: 30 },
    },
    alternateRowStyles: { fillColor: [245, 245, 250] },
  });

  doc.save(`${projectName}_shot_list.pdf`);
}

export async function exportDialogueListPdf(entries: DialogueEntry[], projectName: string) {
  const doc = await makePdf();
  const startY = pdfHeader(doc, "DIALOGUE LIST / TRANSCRIPT", projectName);

  await runAutoTable(doc, {
    startY,
    head: [["TC In", "TC Out", "Speaker", "Dialogue", "V/O", "Lang", "Notes"]],
    body: entries.map((e) => [
      e.tcIn,
      e.tcOut,
      e.speaker,
      e.dialogue,
      e.isNarration ? "YES" : "",
      e.language,
      e.notes,
    ]),
    styles: { fontSize: 7, cellPadding: 2 },
    headStyles: { fillColor: [40, 40, 55], textColor: [200, 200, 220], fontSize: 7 },
    columnStyles: {
      0: { cellWidth: 25, font: "courier" },
      1: { cellWidth: 25, font: "courier" },
      2: { cellWidth: 28 },
      3: { cellWidth: "auto" },
      4: { cellWidth: 12 },
      5: { cellWidth: 12 },
      6: { cellWidth: 30 },
    },
    alternateRowStyles: { fillColor: [245, 245, 250] },
  });

  doc.save(`${projectName}_dialogue_list.pdf`);
}

export async function exportGraphicsListPdf(entries: GraphicsEntry[], projectName: string) {
  const doc = await makePdf();
  const startY = pdfHeader(doc, "GRAPHICS LOG", projectName);

  await runAutoTable(doc, {
    startY,
    head: [["TC In", "TC Out", "Type", "Content", "Position", "Notes"]],
    body: entries.map((e) => [
      e.tcIn,
      e.tcOut,
      e.graphicType.replace(/_/g, " "),
      e.content,
      e.position,
      e.notes,
    ]),
    styles: { fontSize: 7, cellPadding: 2 },
    headStyles: { fillColor: [40, 40, 55], textColor: [200, 200, 220], fontSize: 7 },
    columnStyles: {
      0: { cellWidth: 25, font: "courier" },
      1: { cellWidth: 25, font: "courier" },
      2: { cellWidth: 25 },
      3: { cellWidth: "auto" },
      4: { cellWidth: 28 },
      5: { cellWidth: 30 },
    },
    alternateRowStyles: { fillColor: [245, 245, 250] },
  });

  doc.save(`${projectName}_graphics_log.pdf`);
}

export async function exportTalentBiosPdf(bios: TalentBio[], projectName: string) {
  const doc = await makePdf();
  const startY = pdfHeader(doc, "TALENT BIOS", projectName);

  await runAutoTable(doc, {
    startY,
    head: [["Name", "Role", "First Appearance", "Bio", "All Appearances"]],
    body: bios.map((b) => [
      b.name,
      b.role,
      b.firstAppearance,
      b.bio,
      b.appearances.join(", "),
    ]),
    styles: { fontSize: 7, cellPadding: 2 },
    headStyles: { fillColor: [40, 40, 55], textColor: [200, 200, 220], fontSize: 7 },
    columnStyles: {
      0: { cellWidth: 30 },
      1: { cellWidth: 25 },
      2: { cellWidth: 25, font: "courier" },
      3: { cellWidth: "auto" },
      4: { cellWidth: 45, font: "courier" },
    },
    alternateRowStyles: { fillColor: [245, 245, 250] },
  });

  doc.save(`${projectName}_talent_bios.pdf`);
}

export async function exportFaunaLogPdf(entries: FaunaEntry[], projectName: string) {
  const doc = await makePdf();
  const startY = pdfHeader(doc, "FAUNA IDENTIFICATION LOG", projectName);

  await runAutoTable(doc, {
    startY,
    head: [["TC In", "TC Out", "Common Name", "Scientific Name", "IUCN Status", "Confidence", "Notes"]],
    body: entries.map((e) => [
      e.tcIn,
      e.tcOut,
      e.commonName,
      e.scientificName,
      `${e.iucnStatus} - ${IUCN_LABELS[e.iucnStatus as IUCNStatus] || e.iucnStatus}`,
      `${Math.round(e.confidence * 100)}%`,
      e.notes,
    ]),
    styles: { fontSize: 7, cellPadding: 2 },
    headStyles: { fillColor: [40, 40, 55], textColor: [200, 200, 220], fontSize: 7 },
    columnStyles: {
      0: { cellWidth: 25, font: "courier" },
      1: { cellWidth: 25, font: "courier" },
      2: { cellWidth: 30 },
      3: { cellWidth: 30, fontStyle: "italic" },
      4: { cellWidth: 30 },
      5: { cellWidth: 18 },
      6: { cellWidth: "auto" },
    },
    alternateRowStyles: { fillColor: [245, 245, 250] },
  });

  doc.save(`${projectName}_fauna_log.pdf`);
}

export async function exportSynopsesPdf(synopses: Synopses, projectName: string) {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const startY = pdfHeader(doc, "SYNOPSES", projectName);

  const sections: { label: string; text: string }[] = [
    { label: "LOGLINE", text: synopses.logline },
    { label: "SHORT SYNOPSIS", text: synopses.shortSynopsis },
    { label: "MEDIUM SYNOPSIS", text: synopses.mediumSynopsis },
    { label: "LONG SYNOPSIS", text: synopses.longSynopsis },
  ];

  let y = startY;
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 14;
  const textWidth = pageWidth - margin * 2;

  for (const section of sections) {
    // Section label
    doc.setFontSize(9);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(60);
    doc.text(section.label, margin, y);
    y += 5;

    // Body text
    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(20);
    const lines = doc.splitTextToSize(section.text || "", textWidth) as string[];
    for (const line of lines) {
      if (y > 275) {
        doc.addPage();
        y = 20;
      }
      doc.text(line, margin, y);
      y += 5.5;
    }
    y += 8; // gap between sections
  }

  doc.save(`${projectName}_synopses.pdf`);
}

// ─── DOCX Exports ─────────────────────────────────────────────────

async function saveDocx(doc: import("docx").Document, filename: string) {
  const { Packer } = await import("docx");
  const { saveAs } = await import("file-saver");
  const blob = await Packer.toBlob(doc);
  saveAs(blob, filename);
}

function docxHeader(title: string, projectName: string, docx: typeof import("docx")) {
  return [
    new docx.Paragraph({
      children: [new docx.TextRun({ text: title, bold: true, size: 32, font: "Helvetica" })],
      spacing: { after: 100 },
    }),
    new docx.Paragraph({
      children: [
        new docx.TextRun({
          text: `Project: ${projectName}  |  Generated: ${new Date().toLocaleDateString()}  |  NEVER v3`,
          size: 18,
          color: "888888",
          font: "Helvetica",
        }),
      ],
      spacing: { after: 300 },
    }),
  ];
}

export async function exportSynopsesDocx(synopses: Synopses, projectName: string) {
  const docx = await import("docx");

  const sections: { label: string; text: string }[] = [
    { label: "LOGLINE", text: synopses.logline },
    { label: "SHORT SYNOPSIS", text: synopses.shortSynopsis },
    { label: "MEDIUM SYNOPSIS", text: synopses.mediumSynopsis },
    { label: "LONG SYNOPSIS", text: synopses.longSynopsis },
  ];

  const children: import("docx").Paragraph[] = [
    ...docxHeader("SYNOPSES", projectName, docx),
    ...sections.flatMap(({ label, text }) => [
      new docx.Paragraph({
        children: [new docx.TextRun({ text: label, bold: true, size: 20, font: "Helvetica", color: "444444" })],
        spacing: { before: 240, after: 80 },
      }),
      new docx.Paragraph({
        children: [new docx.TextRun({ text: text || "", size: 20, font: "Helvetica" })],
        spacing: { after: 160 },
      }),
    ]),
  ];

  const doc = new docx.Document({ sections: [{ children }] });
  await saveDocx(doc, `${projectName}_synopses.docx`);
}

export async function exportShotListDocx(shots: ShotEntry[], projectName: string) {
  const docx = await import("docx");

  const rows = [
    new docx.TableRow({
      tableHeader: true,
      children: ["#", "TC In", "TC Out", "Duration", "Type", "Camera", "Description"].map(
        (text) =>
          new docx.TableCell({
            children: [new docx.Paragraph({ children: [new docx.TextRun({ text, bold: true, size: 16, font: "Helvetica" })] })],
            shading: { fill: "282837", color: "C8C8DC" },
          })
      ),
    }),
    ...shots.map(
      (s) =>
        new docx.TableRow({
          children: [
            String(s.shotNumber), s.tcIn, s.tcOut, s.duration, s.sceneType, s.cameraMovement, s.description,
          ].map(
            (text, i) =>
              new docx.TableCell({
                children: [new docx.Paragraph({
                  children: [new docx.TextRun({ text, size: 16, font: i >= 1 && i <= 3 ? "Courier New" : "Helvetica" })],
                })],
              })
          ),
        })
    ),
  ];

  const doc = new docx.Document({
    sections: [{
      children: [
        ...docxHeader("SHOT LIST", projectName, docx),
        new docx.Table({ rows, width: { size: 100, type: docx.WidthType.PERCENTAGE } }),
      ],
    }],
  });

  await saveDocx(doc, `${projectName}_shot_list.docx`);
}

export async function exportDialogueListDocx(entries: DialogueEntry[], projectName: string) {
  const docx = await import("docx");

  const rows = [
    new docx.TableRow({
      tableHeader: true,
      children: ["TC In", "TC Out", "Speaker", "Dialogue", "V/O", "Notes"].map(
        (text) =>
          new docx.TableCell({
            children: [new docx.Paragraph({ children: [new docx.TextRun({ text, bold: true, size: 16, font: "Helvetica" })] })],
            shading: { fill: "282837", color: "C8C8DC" },
          })
      ),
    }),
    ...entries.map(
      (e) =>
        new docx.TableRow({
          children: [e.tcIn, e.tcOut, e.speaker, e.dialogue, e.isNarration ? "YES" : "", e.notes].map(
            (text, i) =>
              new docx.TableCell({
                children: [new docx.Paragraph({
                  children: [new docx.TextRun({ text, size: 16, font: i <= 1 ? "Courier New" : "Helvetica" })],
                })],
              })
          ),
        })
    ),
  ];

  const doc = new docx.Document({
    sections: [{
      children: [
        ...docxHeader("DIALOGUE LIST / TRANSCRIPT", projectName, docx),
        new docx.Table({ rows, width: { size: 100, type: docx.WidthType.PERCENTAGE } }),
      ],
    }],
  });

  await saveDocx(doc, `${projectName}_dialogue_list.docx`);
}

export async function exportGraphicsListDocx(entries: GraphicsEntry[], projectName: string) {
  const docx = await import("docx");

  const rows = [
    new docx.TableRow({
      tableHeader: true,
      children: ["TC In", "TC Out", "Type", "Content", "Position", "Notes"].map(
        (text) =>
          new docx.TableCell({
            children: [new docx.Paragraph({ children: [new docx.TextRun({ text, bold: true, size: 16, font: "Helvetica" })] })],
            shading: { fill: "282837", color: "C8C8DC" },
          })
      ),
    }),
    ...entries.map(
      (e) =>
        new docx.TableRow({
          children: [e.tcIn, e.tcOut, e.graphicType.replace(/_/g, " "), e.content, e.position, e.notes].map(
            (text, i) =>
              new docx.TableCell({
                children: [new docx.Paragraph({
                  children: [new docx.TextRun({ text, size: 16, font: i <= 1 ? "Courier New" : "Helvetica" })],
                })],
              })
          ),
        })
    ),
  ];

  const doc = new docx.Document({
    sections: [{
      children: [
        ...docxHeader("GRAPHICS LOG", projectName, docx),
        new docx.Table({ rows, width: { size: 100, type: docx.WidthType.PERCENTAGE } }),
      ],
    }],
  });

  await saveDocx(doc, `${projectName}_graphics_log.docx`);
}

export async function exportTalentBiosDocx(bios: TalentBio[], projectName: string) {
  const docx = await import("docx");

  const rows = [
    new docx.TableRow({
      tableHeader: true,
      children: ["Name", "Role", "First Appearance", "Bio", "All Appearances"].map(
        (text) =>
          new docx.TableCell({
            children: [new docx.Paragraph({ children: [new docx.TextRun({ text, bold: true, size: 16, font: "Helvetica" })] })],
            shading: { fill: "282837", color: "C8C8DC" },
          })
      ),
    }),
    ...bios.map(
      (b) =>
        new docx.TableRow({
          children: [b.name, b.role, b.firstAppearance, b.bio, b.appearances.join(", ")].map(
            (text, i) =>
              new docx.TableCell({
                children: [new docx.Paragraph({
                  children: [new docx.TextRun({ text, size: 16, font: i === 2 || i === 4 ? "Courier New" : "Helvetica" })],
                })],
              })
          ),
        })
    ),
  ];

  const doc = new docx.Document({
    sections: [{
      children: [
        ...docxHeader("TALENT BIOS", projectName, docx),
        new docx.Table({ rows, width: { size: 100, type: docx.WidthType.PERCENTAGE } }),
      ],
    }],
  });

  await saveDocx(doc, `${projectName}_talent_bios.docx`);
}

export async function exportFaunaLogDocx(entries: FaunaEntry[], projectName: string) {
  const docx = await import("docx");

  const rows = [
    new docx.TableRow({
      tableHeader: true,
      children: ["TC In", "TC Out", "Common Name", "Scientific Name", "IUCN", "Confidence", "Notes"].map(
        (text) =>
          new docx.TableCell({
            children: [new docx.Paragraph({ children: [new docx.TextRun({ text, bold: true, size: 16, font: "Helvetica" })] })],
            shading: { fill: "282837", color: "C8C8DC" },
          })
      ),
    }),
    ...entries.map(
      (e) =>
        new docx.TableRow({
          children: [
            e.tcIn,
            e.tcOut,
            e.commonName,
            e.scientificName,
            `${e.iucnStatus} - ${IUCN_LABELS[e.iucnStatus as IUCNStatus] || e.iucnStatus}`,
            `${Math.round(e.confidence * 100)}%`,
            e.notes,
          ].map(
            (text, i) =>
              new docx.TableCell({
                children: [new docx.Paragraph({
                  children: [new docx.TextRun({
                    text,
                    size: 16,
                    font: i <= 1 ? "Courier New" : "Helvetica",
                    italics: i === 3,
                  })],
                })],
              })
          ),
        })
    ),
  ];

  const doc = new docx.Document({
    sections: [{
      children: [
        ...docxHeader("FAUNA IDENTIFICATION LOG", projectName, docx),
        new docx.Table({ rows, width: { size: 100, type: docx.WidthType.PERCENTAGE } }),
      ],
    }],
  });

  await saveDocx(doc, `${projectName}_fauna_log.docx`);
}
