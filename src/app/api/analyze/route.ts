import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { streamText } from "ai";
import { NextRequest } from "next/server";
import { AnalysisType, FrameRate } from "@/lib/types";
import {
  SHOT_LIST_PROMPT,
  DIALOGUE_LIST_PROMPT,
  GRAPHICS_LIST_PROMPT,
  SYNOPSES_PROMPT,
  TALENT_BIOS_PROMPT,
  FAUNA_LOG_PROMPT,
} from "@/lib/prompts";

export const runtime = "nodejs";
export const maxDuration = 300;

function getPrompt(
  type: AnalysisType,
  frameRate: FrameRate,
  dropFrame: boolean,
  language: string
): string {
  switch (type) {
    case "shot_list":
      return SHOT_LIST_PROMPT(frameRate, dropFrame, language);
    case "dialogue_list":
      return DIALOGUE_LIST_PROMPT(frameRate, dropFrame, language);
    case "graphics_list":
      return GRAPHICS_LIST_PROMPT(frameRate, dropFrame, language);
    case "synopses":
      return SYNOPSES_PROMPT(language);
    case "talent_bios":
      return TALENT_BIOS_PROMPT(frameRate, dropFrame, language, "");
    case "fauna_log":
      return FAUNA_LOG_PROMPT(frameRate, dropFrame, language, "");
  }
}

/**
 * Streaming analyze endpoint using Vercel AI SDK + @ai-sdk/google.
 * Uses streamText for proper SSE streaming that keeps the connection alive.
 *
 * Response: SSE stream with text chunks, assembled into JSON on the client.
 */
export async function POST(request: NextRequest) {
  const t0 = Date.now();
  try {
    const body = await request.json();
    const {
      apiKey,
      geminiUri,
      mimeType,
      analysisType,
      frameRate,
      dropFrame,
      language,
    } = body as {
      apiKey: string;
      geminiUri: string;
      mimeType: string;
      analysisType: AnalysisType;
      frameRate: FrameRate;
      dropFrame: boolean;
      language: string;
    };

    if (!apiKey || !analysisType) {
      return Response.json({ error: "Missing required fields" }, { status: 400 });
    }

    if (!geminiUri) {
      return Response.json({ error: "No video file found. Please upload first." }, { status: 400 });
    }

    console.log(`[analyze] Starting ${analysisType} streaming analysis for ${geminiUri}`);

    const google = createGoogleGenerativeAI({ apiKey });

    const prompt = getPrompt(analysisType, frameRate, dropFrame, language);

    const result = streamText({
      model: google("gemini-2.5-flash"),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            {
              type: "file",
              data: new URL(geminiUri),
              mediaType: mimeType,
            },
          ],
        },
      ],
      providerOptions: {
        google: {
          responseModalities: ["TEXT"],
          responseMimeType: "application/json",
          thinkingConfig: { thinkingBudget: 0 },
        },
      },
      timeout: {
        totalMs: 290000,   // Just under 300s maxDuration
        chunkMs: 120000,   // Abort if no chunk for 2 minutes
      },
      onError: ({ error }) => {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        console.error(`[analyze] streamText error after ${elapsed}s:`, error);
      },
      onFinish: ({ text }) => {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`[analyze] Gemini finished in ${elapsed}s, ${text.length} chars`);
      },
    });

    // Return the streaming response — Vercel AI SDK handles SSE format
    return result.toTextStreamResponse();
  } catch (error: unknown) {
    console.error(`[analyze] Error after ${((Date.now() - t0) / 1000).toFixed(1)}s:`, error);
    const message = error instanceof Error ? error.message : "Analysis failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
