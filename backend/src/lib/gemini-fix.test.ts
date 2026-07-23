import { describe, expect, it } from "vitest";
import { generateDeterministicFix, type FixFindingInput } from "./gemini-fix.js";

const EVAL_FINDING: FixFindingInput = {
  title: "Code Injection via eval()",
  cwe: "CWE-94",
  filePath: "src/legacy/evalRunner.js",
  lineStart: 3,
  lineEnd: 3,
  evidence: "User input is passed directly to eval().",
  remediationGuidance: "Remove eval and validate the expression before executing it.",
};

describe("generateDeterministicFix", () => {
  it("replaces eval calls in JS code-injection findings with the safe expression helper", () => {
    const source = `"use strict";

export function runExpression(expression) {
  return eval(expression);
}
`;

    const fix = generateDeterministicFix(EVAL_FINDING, source);

    expect(fix?.confident).toBe(true);
    expect(fix?.fixedContent).toContain("function safeEvaluateExpression(input)");
    expect(fix?.fixedContent).toContain("return safeEvaluateExpression(expression);");
    expect(fix?.fixedContent).not.toContain("eval(expression)");

    const helperSource = fix?.fixedContent.slice(0, fix.fixedContent.indexOf("\n\nexport"));
    const safeEvaluateExpression = new Function(`${helperSource}; return safeEvaluateExpression;`)() as (input: string) => number;
    expect(safeEvaluateExpression("1 + 2 * (3 + 4)")).toBe(15);
    expect(() => safeEvaluateExpression("process.exit()")).toThrow("Unsafe expression");
  });

  it("does not rewrite unrelated JavaScript findings", () => {
    const fix = generateDeterministicFix(
      { ...EVAL_FINDING, title: "Missing authorization check", cwe: "CWE-862" },
      "export const x = eval(input);\n",
    );

    expect(fix).toBeNull();
  });
});
