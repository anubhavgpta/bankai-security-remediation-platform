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

const GeminiFileUpdateSchema = z.object({
  filePath: z.string(),
  fixedContent: z.string(),
});

const GeminiFixResultSchema = z.object({
  confident: z.boolean(),
  fixedContent: z.string(),
  summary: z.string().min(1),
  filesToUpdate: z.array(GeminiFileUpdateSchema).optional(),
});

export type GeneratedFix = z.infer<typeof GeminiFixResultSchema>;

export interface FixRetryContext {
  attempt: number; // this attempt's number (2 or 3 — 1 is the original, non-retry call)
  maxAttempts: number;
  failedStage: string;
  failureLog: string | null;
}

// Mirrors GeminiFixResultSchema above
const RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    confident: {
      type: Type.BOOLEAN,
      description:
        "true only if fixedContent is a correct, complete fix for the described vulnerability that changes nothing else. false if you cannot produce such a fix — when false, fixedContent must be returned unchanged from the original.",
    },
    fixedContent: {
      type: Type.STRING,
      description: "The entire corrected main file content, verbatim, ready to be committed as-is (not a diff/patch).",
    },
    summary: {
      type: Type.STRING,
      description: "1-3 sentences describing what was changed and why, suitable for a commit message and PR description.",
    },
    filesToUpdate: {
      type: Type.ARRAY,
      description:
        "Optional array of additional files to update alongside the main file (e.g. schemas, imports, or test fixtures) if the fix requires multi-file updates.",
      items: {
        type: Type.OBJECT,
        properties: {
          filePath: { type: Type.STRING, description: "Relative file path in the repository." },
          fixedContent: { type: Type.STRING, description: "Entire corrected file content, verbatim." },
        },
        required: ["filePath", "fixedContent"],
      },
    },
  },
  required: ["confident", "fixedContent", "summary"],
};

const SYSTEM_PROMPT = `You are a senior application security engineer producing a surgical code fix for an identified vulnerability.

Change only what is necessary to remediate the specific issue described — preserve all unrelated code, formatting, comments, and style. Ensure your fix complies with existing interfaces, test suites, and repository contracts provided in context.

Return the ENTIRE corrected target file content in fixedContent (not a diff/patch), so it can be committed verbatim.
If the fix requires complementary updates to related files (e.g. schema definitions or test helpers), include them in filesToUpdate.

If you cannot produce a fix you are highly confident is both correct and complete, set confident:false and return fixedContent identical to the original file content.

Respond with JSON matching the provided schema.`;

const RETRY_SYSTEM_PROMPT_ADDENDUM = `

This is a retry: a previous attempt of yours already fixed this vulnerability and was committed, but automated CI verification failed. The file content given to you below is that previous attempt's code, not the original vulnerable file, and a CI failure log is included showing what went wrong.

Before changing anything, decide which of these two cases applies:
1. Your previous fix has a genuine bug or is incomplete — the failure is something you can and should fix. Produce a revised fixedContent (and filesToUpdate if relevant).
2. The failing test is itself asserting or requiring the vulnerable behavior — your fix is correct and the test itself is the obstacle. No revised code can make both the test and the security fix pass.

If case 2 applies, set confident:false and use summary to explain, in plain language, why the failing test requires the vulnerable behavior to remain.`;

const SAFE_EVALUATE_EXPRESSION_HELPER = `function safeEvaluateExpression(input) {
  const expression = String(input).trim();
  if (!/^[0-9+\\-*\\/%().\\s]+$/.test(expression)) {
    throw new Error("Unsafe expression");
  }

  let index = 0;

  function skipWhitespace() {
    while (index < expression.length && /\\s/.test(expression[index])) index++;
  }

  function parseNumber() {
    skipWhitespace();
    const start = index;
    while (index < expression.length && /[0-9.]/.test(expression[index])) index++;
    if (start === index) throw new Error("Invalid expression");
    const raw = expression.slice(start, index);
    if (!/^\\d+(?:\\.\\d+)?$/.test(raw)) throw new Error("Invalid number");
    return Number(raw);
  }

  function parseFactor() {
    skipWhitespace();
    if (expression[index] === "+") {
      index++;
      return parseFactor();
    }
    if (expression[index] === "-") {
      index++;
      return -parseFactor();
    }
    if (expression[index] === "(") {
      index++;
      const value = parseExpression();
      skipWhitespace();
      if (expression[index] !== ")") throw new Error("Unbalanced expression");
      index++;
      return value;
    }
    return parseNumber();
  }

  function parseTerm() {
    let value = parseFactor();
    while (true) {
      skipWhitespace();
      const operator = expression[index];
      if (operator !== "*" && operator !== "/" && operator !== "%") break;
      index++;
      const right = parseFactor();
      if (operator === "*") value *= right;
      else if (operator === "/") value /= right;
      else value %= right;
    }
    return value;
  }

  function parseExpression() {
    let value = parseTerm();
    while (true) {
      skipWhitespace();
      const operator = expression[index];
      if (operator !== "+" && operator !== "-") break;
      index++;
      const right = parseTerm();
      if (operator === "+") value += right;
      else value -= right;
    }
    return value;
  }

  const result = parseExpression();
  skipWhitespace();
  if (index !== expression.length || !Number.isFinite(result)) {
    throw new Error("Invalid expression");
  }
  return result;
}`;

function isEvalCodeInjectionFinding(finding: FixFindingInput): boolean {
  const text = [finding.title, finding.cwe ?? "", finding.evidence, finding.remediationGuidance].join(" ").toLowerCase();
  return (
    (text.includes("eval") && (text.includes("code injection") || text.includes("injection") || text.includes("unsafe"))) ||
    text.includes("cwe-94") ||
    text.includes("cwe-95")
  );
}

function isJavaScriptLikePath(filePath: string): boolean {
  return /\.(?:c?m?js|jsx|tsx?|vue|svelte)$/i.test(filePath);
}

function findMatchingParen(source: string, openIndex: number): number {
  let depth = 0;
  let quote: '"' | "'" | "`" | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = openIndex; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];

    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "/" && next === "/") {
      lineComment = true;
      i++;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      i++;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") depth++;
    if (char === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }

  return -1;
}

function replaceEvalCalls(source: string): { content: string; replacements: number } {
  const evalCallPattern = /\beval\s*\(/g;
  let output = "";
  let cursor = 0;
  let replacements = 0;
  let match: RegExpExecArray | null;

  while ((match = evalCallPattern.exec(source))) {
    const evalIndex = match.index;
    const before = source[evalIndex - 1];
    const afterName = source[evalIndex + 4];
    if ((before && /[$\w]/.test(before)) || (afterName && /[$\w]/.test(afterName))) continue;

    const openIndex = source.indexOf("(", evalIndex);
    const closeIndex = findMatchingParen(source, openIndex);
    if (closeIndex === -1) continue;

    const argument = source.slice(openIndex + 1, closeIndex).trim();
    output += source.slice(cursor, evalIndex);
    output += `safeEvaluateExpression(${argument})`;
    cursor = closeIndex + 1;
    replacements++;
    evalCallPattern.lastIndex = closeIndex + 1;
  }

  return { content: output + source.slice(cursor), replacements };
}

function insertHelper(source: string, helper: string): string {
  if (source.includes("function safeEvaluateExpression(") || source.includes("const safeEvaluateExpression")) {
    return source;
  }

  const shebangMatch = source.match(/^#!.*\n/);
  const shebang = shebangMatch?.[0] ?? "";
  let rest = source.slice(shebang.length);
  const directiveMatch = rest.match(/^((?:\s*["']use strict["'];?\s*\n)+)/);
  const directiveBlock = directiveMatch?.[0] ?? "";
  rest = rest.slice(directiveBlock.length);

  return `${shebang}${directiveBlock}${helper}\n\n${rest}`;
}

export function generateDeterministicFix(finding: FixFindingInput, fileContent: string): GeneratedFix | null {
  if (!isJavaScriptLikePath(finding.filePath) || !isEvalCodeInjectionFinding(finding) || !/\beval\s*\(/.test(fileContent)) {
    return null;
  }

  const replaced = replaceEvalCalls(fileContent);
  if (replaced.replacements === 0 || replaced.content === fileContent) {
    return null;
  }

  const fixedContent = insertHelper(replaced.content, SAFE_EVALUATE_EXPRESSION_HELPER);
  return {
    confident: true,
    fixedContent,
    summary:
      "Replaced unsafe eval() execution with a small arithmetic expression parser that rejects non-expression input before evaluation.",
  };
}

function buildUserPrompt(
  finding: FixFindingInput,
  fileContent: string,
  retryContext?: FixRetryContext,
  repoContextPrompt?: string,
): string {
  const numbered = fileContent
    .split("\n")
    .map((line, i) => `${i + 1}: ${line}`)
    .join("\n");

  const location =
    finding.lineStart != null
      ? `Lines ${finding.lineStart}${finding.lineEnd && finding.lineEnd !== finding.lineStart ? `-${finding.lineEnd}` : ""}`
      : "No specific line range";

  const contextHeader = repoContextPrompt ? `${repoContextPrompt}\n\n` : "";

  return `${contextHeader}Vulnerability: ${finding.title}
CWE: ${finding.cwe ?? "N/A"}
File: ${finding.filePath}
${location}

Evidence:
${finding.evidence}

Remediation guidance:
${finding.remediationGuidance}

=== TARGET FILE: ${finding.filePath} ===
${numbered}${
    retryContext
      ? `\n\n=== CI FAILURE (attempt ${retryContext.attempt} of ${retryContext.maxAttempts}, stage: ${retryContext.failedStage}) ===\n${retryContext.failureLog ?? "(log unavailable — no further detail than the stage name)"}`
      : ""
  }`;
}

// Best-effort, same contract as gemini.ts's analyzeChunk: 2 attempts, never
// throws — a fix-generation failure degrades to "no PR", never blocks upstream.
export async function generateFix(
  finding: FixFindingInput,
  fileContent: string,
  retryContext?: FixRetryContext,
  repoContextPrompt?: string,
): Promise<GeneratedFix | null> {
  if (fileContent.length > env.MAX_SCAN_FILE_BYTES) {
    logger.warn(
      { filePath: finding.filePath, size: fileContent.length },
      "Skipping AI fix generation — file exceeds MAX_SCAN_FILE_BYTES",
    );
    return null;
  }

  const contents = buildUserPrompt(finding, fileContent, retryContext, repoContextPrompt);
  const systemInstruction = retryContext ? SYSTEM_PROMPT + RETRY_SYSTEM_PROMPT_ADDENDUM : SYSTEM_PROMPT;

  for (let attempt = 1; attempt <= 2; attempt++) {
    let text: string | undefined;
    try {
      const response = await getGeminiClient().models.generateContent({
        model: env.GEMINI_MODEL,
        contents,
        config: {
          systemInstruction,
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
  const deterministicFix = retryContext ? null : generateDeterministicFix(finding, fileContent);
  if (deterministicFix) {
    logger.warn({ filePath: finding.filePath }, "Using deterministic eval-remediation fallback after repeated Gemini failures");
    return deterministicFix;
  }
  return null;
}
