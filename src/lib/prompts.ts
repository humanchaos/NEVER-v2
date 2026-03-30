import { FrameRate } from "./types";

const LANG_NAMES: Record<string, string> = {
  en: "English", de: "German", fr: "French", es: "Spanish",
  it: "Italian", pt: "Portuguese", ja: "Japanese", zh: "Chinese",
  ko: "Korean", ar: "Arabic", ru: "Russian", hi: "Hindi",
  nl: "Dutch", sv: "Swedish", da: "Danish", no: "Norwegian",
  fi: "Finnish", pl: "Polish", cs: "Czech", tr: "Turkish",
};

const TC_INSTRUCTIONS = (frameRate: FrameRate, dropFrame: boolean) => `
TIMECODE FORMAT:
- Frame rate: ${frameRate} fps
- Format: ${dropFrame ? "Drop-Frame (HH:MM:SS;FF)" : "Non-Drop-Frame (HH:MM:SS:FF)"}
- Separator: ${dropFrame ? "semicolon (;) between seconds and frames" : "colon (:) between all fields"}
- All timecodes MUST be exactly 4 fields: HH:MM:SS${dropFrame ? ";" : ":"}FF (hours:minutes:seconds${dropFrame ? ";" : ":"}frames). NEVER omit the hours or frames field.
- All timecodes MUST be accurate to the frame shown on screen.
- IMPORTANT: Timecodes MUST be relative to the START of the provided video clip. The first frame of the clip is 00:00:00${dropFrame ? ";" : ":"}00 regardless of where the clip appears in the original recording.
`;

const LANG_INSTRUCTION = (language: string) => {
  if (language === "auto") {
    return `\nOUTPUT LANGUAGE: Detect the primary spoken/written language of the video and write ALL text output (descriptions, notes, bios, synopses) in that SAME language. If the video contains multiple languages, use the dominant spoken language. Preserve proper nouns and technical terms in their original form.\n`;
  }
  const name = LANG_NAMES[language] || language;
  return `\nOUTPUT LANGUAGE: Write ALL text output (descriptions, notes, bios, synopses, names) in ${name}. If the spoken language in the video differs from ${name}, still write descriptions and notes in ${name} but preserve proper nouns and technical terms.\n`;
};

const ANTI_REPETITION_INSTRUCTION = `
STOP WHEN DONE — DO NOT LOOP:
- Every entry MUST describe unique content. Never write the same description twice.
- When you have logged all real content, STOP and close the JSON array immediately.
- If you notice you are about to repeat a description you already wrote, you have reached the end of the real content — stop there. Do not add any more entries.
- It is better to return a short accurate list than a long list padded with repeated or invented entries.
`;

export const SHOT_LIST_PROMPT = (frameRate: FrameRate, dropFrame: boolean, language: string) => `
You are an expert assistant editor creating a broadcast-standard shot list.

Analyze this video and create a detailed shot list logging every camera cut.

IMPORTANT: Each shot must be at least 8 frames long. Do NOT create entries for momentary flashes, single frames, or sub-second cuts — these are compression artefacts, not real editorial shots. If you are unsure whether a cut is real, merge it with the adjacent shot.

${TC_INSTRUCTIONS(frameRate, dropFrame)}
${LANG_INSTRUCTION(language)}

For each shot, provide:
1. Shot number (sequential)
2. TC In (timecode of the first frame)
3. TC Out (timecode of the last frame)
4. Duration (TC Out - TC In)
5. Description (brief visual description, max 15 words)
6. Scene Type (e.g., "Wide Shot", "Close-Up", "Medium Shot", "Aerial", "Insert", "B-Roll", "Interview", etc.)
7. Camera Movement (e.g., "Static", "Pan Left", "Tilt Up", "Dolly In", "Handheld", "Drone", "Tracking", etc.)
8. Notes (any relevant notes about the shot)

${ANTI_REPETITION_INSTRUCTION}
Return ONLY valid JSON in this exact format:
{
  "shots": [
    {
      "shotNumber": 1,
      "tcIn": "00:00:00${dropFrame ? ";" : ":"}00",
      "tcOut": "00:00:05${dropFrame ? ";" : ":"}12",
      "duration": "00:00:05${dropFrame ? ";" : ":"}12",
      "description": "Wide establishing shot of mountain landscape at dawn",
      "sceneType": "Wide Shot",
      "cameraMovement": "Slow Pan Right",
      "notes": ""
    }
  ]
}
`;

export const DIALOGUE_LIST_PROMPT = (frameRate: FrameRate, dropFrame: boolean, language: string) => `
You are an expert assistant editor creating a broadcast-standard dialogue list / transcript.

Analyze this video and create a frame-accurate transcript of ALL spoken dialogue, narration, and voice-over.

${TC_INSTRUCTIONS(frameRate, dropFrame)}
${LANG_INSTRUCTION(language)}

For each dialogue entry, provide:
1. TC In (timecode when speaking begins)
2. TC Out (timecode when speaking ends)
3. Speaker (name of person speaking, or "NARRATOR" for voice-over/narration)
4. Dialogue (exact words spoken, verbatim)
5. Is Narration (true if voice-over/narration, false if on-camera dialogue)
6. Language (${language} unless a different language is spoken)
7. Notes (e.g., "(whispering)", "(phone)", "(archival audio)")

${ANTI_REPETITION_INSTRUCTION}
Return ONLY valid JSON:
{
  "entries": [
    {
      "tcIn": "00:00:10${dropFrame ? ";" : ":"}00",
      "tcOut": "00:00:15${dropFrame ? ";" : ":"}12",
      "speaker": "NARRATOR",
      "dialogue": "In the heart of the Austrian Alps...",
      "isNarration": true,
      "language": "${language}",
      "notes": ""
    }
  ]
}
`;

export const GRAPHICS_LIST_PROMPT = (frameRate: FrameRate, dropFrame: boolean, language: string) => `
You are an expert assistant editor creating a broadcast-standard graphics log.

Analyze this video and log ONLY production graphics — designed, composed text elements that are part of the film's visual language.

LOG these graphic types:
- Lower thirds / chyrons: name and title supers identifying a person on screen (e.g. "Dr. Jane Smith / Marine Biologist")
- Title cards: film title, chapter titles, section headings, location cards, time/date stamps
- Credits: opening or closing credit sequences
- Info-graphics: maps, statistics, diagrams, or factual text overlays
- Logos and watermarks: network bugs, production company logos
- Any other deliberately designed text element that is NOT dialogue

DO NOT LOG:
- Dialogue subtitles or captions (lines of spoken speech displayed as text, typically at the bottom of frame)
- Interview transcripts displayed as subtitles
- Any text that is simply a caption of what someone is saying

${TC_INSTRUCTIONS(frameRate, dropFrame)}
${LANG_INSTRUCTION(language)}

For each graphic, provide:
1. TC In (timecode when graphic first appears)
2. TC Out (timecode when graphic disappears)
3. Graphic Type: "lower_third", "title_card", "credit", "info_graphic", "logo", or "other"
4. Content (exact text shown on screen)
5. Position (e.g., "lower third left", "center", "upper right")
6. Notes (font color, animation, background, etc.)

${ANTI_REPETITION_INSTRUCTION}
Return ONLY valid JSON:
{
  "entries": [
    {
      "tcIn": "00:00:10${dropFrame ? ";" : ":"}00",
      "tcOut": "00:00:15${dropFrame ? ";" : ":"}00",
      "graphicType": "lower_third",
      "content": "Dr. Jane Smith, Marine Biologist",
      "position": "lower third left",
      "notes": "White text on semi-transparent black bar"
    }
  ]
}
`;

export const SYNOPSES_PROMPT = (language: string) => `
You are an expert film publicist writing broadcast-standard synopses for a documentary.

${LANG_INSTRUCTION(language)}

Watch this video carefully and write:

1. LOGLINE: A single compelling sentence (max 30 words) that captures the essence.
2. SHORT SYNOPSIS: 2-3 sentences (50-75 words). Focus on the central story/conflict.
3. MEDIUM SYNOPSIS: 1 paragraph (150-200 words). Include key characters and narrative arc.
4. LONG SYNOPSIS: 3-4 paragraphs (400-600 words). Detailed narrative covering all major story beats, characters, and themes. Do NOT reveal the ending unless it's essential.

Return ONLY valid JSON:
{
  "logline": "...",
  "shortSynopsis": "...",
  "mediumSynopsis": "...",
  "longSynopsis": "..."
}
`;

export const TALENT_BIOS_PROMPT = (frameRate: FrameRate, dropFrame: boolean, language: string, clipEndTC: string) => `
You are an expert researcher creating talent profiles for a documentary's deliverables package.

Analyze this video and identify every person who is VISUALLY ON SCREEN (their face or body is visible in the frame).

NAME IDENTIFICATION — use ALL of these sources, in priority order:
1. LOWER THIRDS / CHYRONS: Text overlays superimposed at the bottom of the frame that name the person. These appear as white or coloured text, often with a title line beneath. Scan every frame carefully — lower thirds are the most reliable source of names.
2. CREDIT SEQUENCES: Opening or closing credits that name cast, crew, interviewees.
3. ON-SCREEN TEXT: Any other text overlays, title cards, or captions that identify people.
4. DIALOGUE: Listen for moments when characters address each other by name ("Thank you, Ellen", "As Lisa explained…"), or when a narrator introduces someone ("Dr Smith has spent 20 years…").
5. CONTEXT / INFERENCE: If none of the above identifies a person, describe them by appearance and role (e.g., "Unidentified male ranger").

CRITICAL: Only log timecodes where the person is VISUALLY VISIBLE in the video frame. Do NOT log timecodes where:
- The person is only heard speaking (voice-over) but B-roll or other footage is shown
- The camera is showing cutaway shots, animals, landscapes, or other subjects while the person speaks
- The person's voice is audible but they are not in the frame

Each timecode in "appearances" and "firstAppearance" must correspond to a frame where the person's face or body is clearly visible on screen.

FIRST APPEARANCE — scan from the very first frame:
- firstAppearance must be the earliest frame in the entire clip where this person is physically on screen.
- The clip begins at 00:00:00${dropFrame ? ";" : ":"}00. Scan from the opening seconds — people often appear before their lower-third is shown.
- Do NOT use a later appearance as firstAppearance just because it is more prominent.

CLIP BOUNDS:
- This clip runs from 00:00:00${dropFrame ? ";" : ":"}00 to ${clipEndTC}.
- ALL timecodes — firstAppearance and every entry in appearances — MUST be ≤ ${clipEndTC}.
- Timecodes beyond ${clipEndTC} do not exist in this clip. Do not include them.

${TC_INSTRUCTIONS(frameRate, dropFrame)}
${LANG_INSTRUCTION(language)}

For each person, provide:
1. Name (from the sources above — prefer the exact name as shown on screen)
2. Role (e.g., "Subject", "Expert", "Narrator", "Director", "Interviewee" — use the title shown in their lower third if available)
3. First Appearance (timecode of the first frame where their face/body is visible)
4. Bio (2-3 sentences about who they are, their expertise, and relevance to the film)
5. All Appearances (list of timecodes where they are VISUALLY on screen — one timecode per distinct on-screen appearance, maximum 10 entries)

${ANTI_REPETITION_INSTRUCTION}
Return ONLY valid JSON:
{
  "bios": [
    {
      "name": "Dr. Jane Smith",
      "role": "Marine Biologist / Expert",
      "firstAppearance": "00:02:30${dropFrame ? ";" : ":"}00",
      "bio": "Dr. Jane Smith is a marine biologist at the University of Vienna...",
      "appearances": ["00:02:30${dropFrame ? ";" : ":"}00", "00:15:42${dropFrame ? ";" : ":"}00"]
    }
  ]
}
`;

export const FAUNA_LOG_PROMPT = (frameRate: FrameRate, dropFrame: boolean, language: string, clipEndTC: string) => `
You are an expert wildlife biologist and nature documentary researcher.

Analyze this video and identify each animal species that is VISUALLY ON SCREEN (the animal is visible in the frame).

CRITICAL: Only log timecodes where the animal is VISUALLY VISIBLE in the video frame. Do NOT log timecodes where:
- The animal is only mentioned in narration or dialogue but not shown
- The camera is showing people, graphics, or other subjects while the animal is discussed
- The animal's sounds are audible but the animal is not in the frame

DO NOT LOG the following — they are not fauna:
- Humans (Homo sapiens) — people, researchers, filmmakers, handlers, or any person on screen
- Equipment or objects (cameras, vehicles, traps, trackers, drones, etc.)
- Taxidermy, sculptures, illustrations, or non-living animal representations

TC In and TC Out must correspond to frames where the animal is clearly visible on screen.

IMPORTANT: Log each species ONCE only — use the timecode of its FIRST appearance in the video. Do not create multiple entries for the same species.

CLIP BOUNDS:
- This clip runs from 00:00:00${dropFrame ? ";" : ":"}00 to ${clipEndTC}.
- Every tcIn and tcOut MUST be ≤ ${clipEndTC}. Any entry with a timecode beyond this is a hallucination — omit it.

CONFIDENCE STANDARD — only log what you can clearly see:
- Only include a species if you are at least 85% confident from what is visually on screen.
- Do NOT infer species from habitat, region, or context. Log only what you can actually see.
- If uncertain of exact genus or species, lower the confidence value and describe your uncertainty in Notes.
- If you find yourself logging more than 4 different species within any 60-second window, stop and reconsider — you are likely pattern-matching from habitat knowledge rather than visual evidence. Keep only the identifications you are most certain about.

${TC_INSTRUCTIONS(frameRate, dropFrame)}
${LANG_INSTRUCTION(language)}

For each species (first appearance only), provide:
1. TC In (timecode of the species' FIRST visible appearance)
2. TC Out (timecode when it leaves frame in that first appearance)
3. Common Name (e.g., "Golden Eagle")
4. Scientific Name (e.g., "Aquila chrysaetos")
5. IUCN Conservation Status: One of LC (Least Concern), NT (Near Threatened), VU (Vulnerable), EN (Endangered), CR (Critically Endangered), EW (Extinct in the Wild), EX (Extinct), DD (Data Deficient), NE (Not Evaluated)
6. Confidence (0.0 to 1.0, how confident you are in the identification)
7. Notes (brief: behavior, habitat, features — max 15 words)

Include ALL non-human animal types: mammals, birds, reptiles, amphibians, fish, insects.
If uncertain of exact species, provide your best identification and lower confidence.

${ANTI_REPETITION_INSTRUCTION}
Return ONLY valid JSON:
{
  "entries": [
    {
      "tcIn": "00:01:15${dropFrame ? ";" : ":"}00",
      "tcOut": "00:01:28${dropFrame ? ";" : ":"}12",
      "commonName": "Golden Eagle",
      "scientificName": "Aquila chrysaetos",
      "iucnStatus": "LC",
      "confidence": 0.95,
      "notes": "Soaring over alpine meadow, distinctive golden nape visible"
    }
  ]
}
`;
