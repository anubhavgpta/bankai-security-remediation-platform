import { Type, type Schema } from "@google/genai";
import { z } from "zod";
import { env } from "../env.js";
import { getGeminiClient } from "./gemini.js";
import { logger } from "./logger.js";

export interface FixFindingInput {
  title: string;
  cwe: string | null;
  filePath: string;
  lineStart: number | null;
  lineEnd: number | null;
  evidence: string;
  remediationGuidance: string;
}

const GeminiFixResultSchema = z.object({
  confident: z.boolean(),
  fixedContent: z.string(),
  summary: z.string().min(1),
});

export type GeneratedFix = z.infer<typeof GeminiFixResultSchema>;

// Mirrors GeminiFixResultSchema above — same hand-written-next-to-zod
// convention as gemini.ts's RESPONSE_SCHEMA, for the same reason (the
// SDK's structured-output vocabulary isn't derivable from a zod schema).
const RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    confident: {
      type: Type.BOOLEAN,
      description:
        "true only if fixedContent is a correct, complete fix for the described vulnerability that changes nothing else. false if you cannot produce such a fix (e.g. it genuinely requires changes to other files, the finding is ambiguous, or you are not highly confident) — when false, fixedContent must be returned unchanged from the original.",
    },
    fixedContent: {
      type: Type.STRING,
      description: "The entire corrected file content, verbatim, ready to be committed as-is (not a diff/patch).",
    },
    summary: {
      type: Type.STRING,
      description: "1-3 sentences describing what was changed and why, suitable for a commit message and PR description.",
    },
  },
  required: ["confident", "fixedContent", "summary"],
};

const SYSTEM_PROMPT = `You are a senior application security engineer producing a minimal, surgical code fix for a single, already-identified vulnerability.

Change only what is necessary to remediate the specific issue described — preserve all unrelated code, formatting, comments, and style exactly as given. Do not refactor, rename, or "improve" anything not required for the fix.

Return the ENTIRE corrected file content in fixedContent (not a diff/patch), so it can be committed verbatim.

If you cannot produce a fix you are highly confident is both correct and complete (e.g. the fix genuinely requires changes to other files, the vulnerability description is ambiguous, or you are not confident), set confident:false and return fixedContent identical to the original file content — never guess.

Respond with JSON matching the provided schema.`;

function buildUserPrompt(finding: FixFindingInput, fileContent: string): string {
  const numbered = fileContent
    .split("\n")
    .map((line, i) => `${i + 1}: ${line}`)
    .join("\n");

  const location =
    finding.lineStart != null
      ? `Lines ${finding.lineStart}${finding.lineEnd && finding.lineEnd !== finding.lineStart ? `-${finding.lineEnd}` : ""}`
      : "No specific line range";

  return `Vulnerability: ${finding.title}
CWE: ${finding.cwe ?? "N/A"}
File: ${finding.filePath}
${location}

Evidence:
${finding.evidence}

Remediation guidance:
${finding.remediationGuidance}

=== FILE: ${finding.filePath} ===
${numbered}`;
}

// Best-effort, same contract as gemini.ts's analyzeChunk: 2 attempts, never
// throws — a fix-generation failure degrades to "no PR" (the branch and
// ticket already exist independently of this), never blocks or breaks
// anything upstream.
export async function generateFix(finding: FixFindingInput, fileContent: string): Promise<GeneratedFix | null> {
  if (fileContent.length > env.MAX_SCAN_FILE_BYTES) {
    logger.warn(
      { filePath: finding.filePath, size: fileContent.length },
      "Skipping AI fix generation — file exceeds MAX_SCAN_FILE_BYTES",
    );
    return null;
  }

  const contents = buildUserPrompt(finding, fileContent);

  for (let attempt = 1; attempt <= 2; attempt++) {
    let text: string | undefined;
    try {
      const response = await getGeminiClient().models.generateContent({
        model: env.GEMINI_MODEL,
        contents,
        config: {
          systemInstruction: SYSTEM_PROMPT,
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
          temperature: 0,
        },
      });
      text = response.text;
    } catch (err) {
      logger.error({ err, attempt, filePath: finding.filePath }, "Gemini fix-generation request failed");
      continue;
    }

    if (!text) {
      logger.error({ attempt, filePath: finding.filePath }, "Gemini returned an empty fix-generation response");
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      logger.error({ err, attempt, filePath: finding.filePath }, "Gemini fix-generation response was not valid JSON");
      continue;
    }

    const result = GeminiFixResultSchema.safeParse(parsed);
    if (!result.success) {
      logger.error(
        { issues: result.error.issues, attempt, filePath: finding.filePath },
        "Gemini fix-generation response did not match the expected schema",
      );
      continue;
    }

    return result.data;
  }

  logger.error({ filePath: finding.filePath }, "Dropping fix generation after repeated Gemini failures");
  return null;
}
