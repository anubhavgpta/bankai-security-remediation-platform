import { GoogleGenAI, Type, type Schema } from "@google/genai";
import { z } from "zod";
import { env } from "../env.js";
import { logger } from "./logger.js";

export interface ScannableFile {
  path: string;
  content: string;
}

export interface GeminiScanContext {
  repo: string;
  commitSha: string;
}

const GeminiFindingSchema = z.object({
  title: z.string().min(1),
  severity: z.enum(["Critical", "High", "Medium", "Low"]),
  cwe: z.string().nullable(),
  filePath: z.string().min(1),
  lineStart: z.number().int().positive().nullable(),
  lineEnd: z.number().int().positive().nullable(),
  evidence: z.string().min(1),
  remediationGuidance: z.string().min(1),
});

const GeminiScanResultSchema = z.object({
  findings: z.array(GeminiFindingSchema),
});

export type GeminiFinding = z.infer<typeof GeminiFindingSchema>;

// Mirrors GeminiFindingSchema above — Gemini's structured-output mode wants
// its own Schema/Type vocabulary, not a JSON Schema, so this is kept
// hand-written and next to the zod schema it must stay in sync with, rather
// than generated, since the two have no shared source of truth in this SDK.
const RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    findings: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING, description: "Short, specific vulnerability title." },
          severity: { type: Type.STRING, enum: ["Critical", "High", "Medium", "Low"] },
          cwe: { type: Type.STRING, nullable: true, description: "e.g. \"CWE-89\", or null if not applicable." },
          filePath: { type: Type.STRING, description: "Exact path as given in the FILE header, unmodified." },
          lineStart: { type: Type.INTEGER, nullable: true },
          lineEnd: { type: Type.INTEGER, nullable: true },
          evidence: { type: Type.STRING, description: "1-3 sentence explanation of why this is a vulnerability." },
          remediationGuidance: {
            type: Type.STRING,
            description:
              "A short newline-separated list of concrete action items (one per line, no numbering or bullet characters) a developer can follow in order to fix this specific instance — each line a single, specific step, concrete enough to act on without further research.",
          },
        },
        required: ["title", "severity", "cwe", "filePath", "lineStart", "lineEnd", "evidence", "remediationGuidance"],
      },
    },
  },
  required: ["findings"],
};

const SYSTEM_PROMPT = `You are a senior application security engineer performing a source code security review.

Only report genuine, exploitable security vulnerabilities — e.g. injection (SQL/NoSQL/command/template), broken authentication or authorization, insecure cryptography or hardcoded secrets/credentials, SSRF, path traversal, insecure deserialization, XXE, unsafe eval/dynamic code execution, missing input validation on security-sensitive paths, insecure direct object references, and similar. Do NOT report code style, missing tests, performance, or general code-quality issues.

For every finding:
- filePath must exactly match the path given in that file's "=== FILE: ... ===" header, unmodified.
- lineStart/lineEnd must reference the line numbers shown in the left margin of that file's content (1-indexed). Use null only if the issue isn't localized to specific lines.
- remediationGuidance must be a short list of concrete action items, one per line (plain text, no numbering or "-"/"•" prefixes — those are added when displayed), ordered the way a developer should actually do them. Each line should be a specific, concrete step (not a general principle) — a developer with no prior context on this finding should be able to follow the list and fix it without further research. Typically 3-6 lines: the core fix, any related hardening (e.g. fail-fast validation, config changes), and where relevant a final "redeploy" / "verify" step.
- Do not invent findings. If a file has no genuine vulnerabilities, don't report anything for it.

Return only findings that meet this bar. Respond with JSON matching the provided schema.`;

function buildUserPrompt(files: ScannableFile[], context: GeminiScanContext): string {
  const fileBlocks = files
    .map((file) => {
      const numbered = file.content
        .split("\n")
        .map((line, i) => `${i + 1}: ${line}`)
        .join("\n");
      return `=== FILE: ${file.path} ===\n${numbered}`;
    })
    .join("\n\n");

  return `Repository: ${context.repo} @ ${context.commitSha}\n\nReview the following files:\n\n${fileBlocks}`;
}

// Chunks files by total character count rather than file count, so a single
// large file can still end up alone in its own request while several small
// files get batched together — keeps each Gemini call comfortably inside
// context limits with room for the system prompt and schema.
export function chunkFiles(files: ScannableFile[], maxCharsPerChunk = 40_000): ScannableFile[][] {
  const chunks: ScannableFile[][] = [];
  let current: ScannableFile[] = [];
  let currentChars = 0;

  for (const file of files) {
    const size = file.content.length;
    if (current.length > 0 && currentChars + size > maxCharsPerChunk) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(file);
    currentChars += size;
  }
  if (current.length > 0) chunks.push(current);

  return chunks;
}

let client: GoogleGenAI | null = null;
// Exported so gemini-fix.ts's fix-generation calls reuse this same client
// instead of constructing a second one.
export function getGeminiClient(): GoogleGenAI {
  if (!client) client = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  return client;
}

async function analyzeChunk(files: ScannableFile[], context: GeminiScanContext): Promise<GeminiFinding[]> {
  const contents = buildUserPrompt(files, context);

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
          // Repeated scans of unchanged code should produce the same
          // findings — low temperature reduces (though doesn't fully
          // eliminate) run-to-run drift in title wording/line pinpointing
          // that would otherwise break fingerprint matching in planIngest.
          temperature: 0,
        },
      });
      text = response.text;
    } catch (err) {
      logger.error({ err, attempt, files: files.map((f) => f.path) }, "Gemini request failed");
      continue;
    }

    if (!text) {
      logger.error({ attempt, files: files.map((f) => f.path) }, "Gemini returned an empty response");
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      logger.error({ err, attempt, files: files.map((f) => f.path) }, "Gemini response was not valid JSON");
      continue;
    }

    const result = GeminiScanResultSchema.safeParse(parsed);
    if (!result.success) {
      logger.error(
        { issues: result.error.issues, attempt, files: files.map((f) => f.path) },
        "Gemini response did not match the expected findings schema",
      );
      continue;
    }

    return result.data.findings;
  }

  // Best-effort, matching the rest of this codebase's philosophy for
  // external integrations: a chunk Gemini couldn't analyze after a retry is
  // dropped (logged above) rather than failing the whole scan.
  logger.error({ files: files.map((f) => f.path) }, "Dropping this chunk after repeated Gemini failures");
  return [];
}

export async function analyzeFiles(files: ScannableFile[], context: GeminiScanContext): Promise<GeminiFinding[]> {
  const chunks = chunkFiles(files);
  const results: GeminiFinding[] = [];
  for (const chunk of chunks) {
    const findings = await analyzeChunk(chunk, context);
    results.push(...findings);
  }
  return results;
}
