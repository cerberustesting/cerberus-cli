import fs from "fs";
import path from "path";
import ts from "typescript";
import YAML from "yaml";
import type { TestAction, TestCaseDetailed, TestCaseStep, TestControl } from "../types.js";

export interface LocalMetadata {
  formatVersion: 1;
  testFolder: string;
  testcase: string;
  application: string;
  description: string;
  detailedDescription?: string;
  priority: number | string;
  status: string;
  type: string;
  active: {
    default: boolean;
    QA: boolean;
    UAT: boolean;
    PROD: boolean;
  };
  conditionOperator?: string;
  properties?: unknown[];
}

export interface LocalState {
  formatVersion: 1;
  serverPayload: TestCaseDetailed;
}

export interface ValidationIssue {
  file: string;
  line?: number;
  message: string;
}

type CerberusDslMetadata = {
  description?: string;
  condition?: string;
  fatal?: boolean;
  screenshot?: "before" | "after" | "both" | "never";
  waitBefore?: number;
  waitAfter?: number;
};

function literal(value: unknown): string {
  return JSON.stringify(value ?? "");
}

function isTrue(value: boolean | "Y" | "N" | undefined): boolean {
  return value === true || value === "Y";
}

function hasText(value: unknown): boolean {
  return value !== undefined && value !== null && String(value) !== "";
}

function actionMetadata(action: TestAction): CerberusDslMetadata {
  const metadata: CerberusDslMetadata = {};

  if (hasText(action.description)) metadata.description = action.description;
  if (hasText(action.conditionOperator) && action.conditionOperator !== "always") {
    metadata.condition = action.conditionOperator;
  }
  if (action.isFatal !== undefined && !isTrue(action.isFatal)) metadata.fatal = false;

  const before = isTrue(action.doScreenshotBefore);
  const after = isTrue(action.doScreenshotAfter);
  if (before && after) metadata.screenshot = "both";
  else if (before) metadata.screenshot = "before";
  else if (after) metadata.screenshot = "after";

  const waitBefore = Number(action.waitBefore);
  const waitAfter = Number(action.waitAfter);
  if (Number.isFinite(waitBefore) && waitBefore !== 0) metadata.waitBefore = waitBefore;
  if (Number.isFinite(waitAfter) && waitAfter !== 0) metadata.waitAfter = waitAfter;

  return metadata;
}

function hasMetadata(metadata: CerberusDslMetadata): boolean {
  return Object.keys(metadata).length > 0;
}

function renderMetadata(metadata: CerberusDslMetadata): string {
  return JSON.stringify(metadata);
}

function playwrightExpression(action: TestAction): string | undefined {
  switch (action.action) {
    case "openUrl":
      return `page.goto(${literal(action.value1)})`;

    case "type":
      return `page.locator(${literal(action.value1)}).fill(${literal(action.value2)})`;

    case "click":
      return `page.locator(${literal(action.value1)}).click()`;

    case "wait": {
      const ms = Number(action.value1 ?? 0);
      return `page.waitForTimeout(${Number.isFinite(ms) ? ms : literal(action.value1)})`;
    }

    default:
      return undefined;
  }
}

function renderExecuteJs(action: TestAction, indent: string, metadata: CerberusDslMetadata): string[] {
  const lines: string[] = [];
  const wrapped = hasMetadata(metadata);

  if (wrapped) {
    lines.push(`${indent}await cerberus.do(`);
    lines.push(`${indent}    page.evaluate(() => {`);
  } else {
    lines.push(`${indent}await page.evaluate(() => {`);
  }

  const bodyIndent = wrapped ? indent + "        " : indent + "    ";
  for (const line of String(action.value1 ?? "").split(/\r?\n/)) {
    lines.push(bodyIndent + line);
  }

  if (wrapped) {
    lines.push(`${indent}    }),`);
    lines.push(`${indent}    ${renderMetadata(metadata)}`);
    lines.push(`${indent});`);
  } else {
    lines.push(`${indent}});`);
  }

  return lines;
}

function renderAction(action: TestAction, indent = "        "): string[] {
  const metadata = actionMetadata(action);
  let lines: string[];

  if (action.action === "calculateProperty") {
    const expression = `cerberus.calculateProperty(${literal(action.value1)})`;
    lines = hasMetadata(metadata)
      ? [`${indent}await cerberus.do(${expression}, ${renderMetadata(metadata)});`]
      : [`${indent}await ${expression};`];
  } else if (action.action === "executeJS") {
    lines = renderExecuteJs(action, indent, metadata);
  } else {
    const expression = playwrightExpression(action);

    if (expression) {
      lines = hasMetadata(metadata)
        ? [`${indent}await cerberus.do(${expression}, ${renderMetadata(metadata)});`]
        : [`${indent}await ${expression};`];
    } else {
      lines = [
        `${indent}await cerberus.action(${literal(action.action)}, ${JSON.stringify({
          value1: action.value1,
          value2: action.value2,
          value3: action.value3,
          conditionOperator: action.conditionOperator,
          isFatal: action.isFatal,
          doScreenshotBefore: action.doScreenshotBefore,
          doScreenshotAfter: action.doScreenshotAfter,
          waitBefore: action.waitBefore,
          waitAfter: action.waitAfter,
          description: action.description,
        })});`,
      ];
    }
  }

  for (const control of action.controls ?? []) {
    lines.push(
      `${indent}await cerberus.control(${literal(control.control)}, ${JSON.stringify({
        value1: control.value1,
        value2: control.value2,
        value3: control.value3,
        conditionOperator: control.conditionOperator,
        isFatal: control.isFatal,
        doScreenshotBefore: control.doScreenshotBefore,
        doScreenshotAfter: control.doScreenshotAfter,
        waitBefore: control.waitBefore,
        waitAfter: control.waitAfter,
        description: control.description,
      })});`
    );
  }

  return lines;
}

export function toLocalMetadata(test: TestCaseDetailed): LocalMetadata {
  return {
    formatVersion: 1,
    testFolder: test.testFolderId,
    testcase: test.testcaseId,
    application: test.application,
    description: test.description,
    detailedDescription: test.detailedDescription,
    priority: test.priority,
    status: test.status,
    type: test.type,
    active: {
      default: test.isActive,
      QA: test.isActiveQA,
      UAT: test.isActiveUAT,
      PROD: test.isActivePROD,
    },
    conditionOperator: test.conditionOperator,
    properties: test.properties ?? [],
  };
}

export function generateSpec(test: TestCaseDetailed): string {
  const lines: string[] = [
    "// Generated by Cerberus CLI.",
    "// Playwright-like DSL interpreted by Cerberus CLI; it is not executed by Playwright.",
    "",
    `test(${literal(test.description || test.testcaseId)}, async ({ page, request, cerberus }) => {`,
  ];

  for (const step of test.steps ?? []) {
    lines.push("");
    lines.push(
      `    await cerberus.step(${literal(step.description || `Step ${step.stepId}`)}, async () => {`
    );

    for (const action of [...(step.actions ?? [])].sort((a, b) => Number(a.sort) - Number(b.sort))) {
      lines.push(...renderAction(action));
    }

    lines.push("    });");
  }

  lines.push("});", "");
  return lines.join("\n");
}

export function writeLocalTest(testDir: string, test: TestCaseDetailed): void {
  fs.mkdirSync(path.join(testDir, ".cerberus"), { recursive: true });
  fs.writeFileSync(path.join(testDir, "cerberus.yaml"), YAML.stringify(toLocalMetadata(test)), "utf8");
  fs.writeFileSync(path.join(testDir, "test.spec.ts"), generateSpec(test), "utf8");
  const state: LocalState = { formatVersion: 1, serverPayload: test };
  fs.writeFileSync(
    path.join(testDir, ".cerberus", "state.json"),
    JSON.stringify(state, null, 2) + "\n",
    "utf8"
  );
}

function stringArg(call: ts.CallExpression, index: number): string | undefined {
  const arg = call.arguments[index];
  if (!arg) return undefined;
  if (ts.isStringLiteralLike(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
  if (ts.isNumericLiteral(arg)) return arg.text;
  return undefined;
}

function sourceLine(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function parseLiteral(value: ts.Expression): unknown {
  if (ts.isStringLiteralLike(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
  if (ts.isNumericLiteral(value)) return Number(value.text);
  if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (value.kind === ts.SyntaxKind.FalseKeyword) return false;
  return undefined;
}

function parseObjectExpression(arg: ts.Expression | undefined): Record<string, unknown> {
  if (!arg || !ts.isObjectLiteralExpression(arg)) return {};

  const result: Record<string, unknown> = {};
  for (const prop of arg.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const key =
      ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name) ? prop.name.text : undefined;
    if (!key) continue;

    const value = parseLiteral(prop.initializer);
    if (value !== undefined) result[key] = value;
  }

  return result;
}

function parseObjectArg(call: ts.CallExpression, index: number): Record<string, unknown> {
  return parseObjectExpression(call.arguments[index]);
}

function baseAction(template: TestAction | undefined): TestAction {
  return template
    ? { ...template, controls: [...(template.controls ?? [])] }
    : {
        testFolderId: "",
        testcaseId: "",
        stepId: 0,
        actionId: 0,
        sort: 0,
        conditionOperator: "always",
        action: "",
        isFatal: true,
        doScreenshotBefore: false,
        doScreenshotAfter: false,
        waitBefore: 0,
        waitAfter: 0,
        controls: [],
      };
}

function locatorValue(call: ts.CallExpression): string | undefined {
  if (!ts.isPropertyAccessExpression(call.expression)) return undefined;
  const receiver = call.expression.expression;
  if (!ts.isCallExpression(receiver)) return undefined;
  if (!ts.isPropertyAccessExpression(receiver.expression)) return undefined;
  if (!ts.isIdentifier(receiver.expression.expression) || receiver.expression.expression.text !== "page") {
    return undefined;
  }
  if (receiver.expression.name.text !== "locator") return undefined;
  return stringArg(receiver, 0);
}

function parseMappedCall(
  call: ts.CallExpression,
  source: ts.SourceFile,
  template: TestAction | undefined,
  issues: ValidationIssue[]
): TestAction | undefined {
  if (!ts.isPropertyAccessExpression(call.expression)) return undefined;

  const receiver = call.expression.expression;
  const method = call.expression.name.text;
  const base = baseAction(template);

  if (ts.isIdentifier(receiver) && receiver.text === "page") {
    if (method === "goto") {
      const value = stringArg(call, 0);
      if (value === undefined) {
        issues.push({ file: source.fileName, line: sourceLine(source, call), message: "page.goto() requires a literal URL." });
        return undefined;
      }
      return { ...base, action: "openUrl", value1: value };
    }

    if (method === "waitForTimeout") {
      const value = stringArg(call, 0);
      if (value === undefined) {
        issues.push({ file: source.fileName, line: sourceLine(source, call), message: "page.waitForTimeout() requires a literal duration." });
        return undefined;
      }
      return { ...base, action: "wait", value1: value };
    }

    if (method === "evaluate") {
      const fn = call.arguments[0];
      if (!fn || (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) || !ts.isBlock(fn.body)) {
        issues.push({ file: source.fileName, line: sourceLine(source, call), message: "page.evaluate() requires an inline function body." });
        return undefined;
      }
      return {
        ...base,
        action: "executeJS",
        value1: fn.body.statements.map((statement) => statement.getText(source)).join("\n"),
      };
    }
  }

  const locator = locatorValue(call);
  if (locator !== undefined) {
    if (method === "fill") {
      const value = stringArg(call, 0);
      if (value === undefined) {
        issues.push({ file: source.fileName, line: sourceLine(source, call), message: "locator.fill() requires a literal value." });
        return undefined;
      }
      return { ...base, action: "type", value1: locator, value2: value };
    }

    if (method === "click") {
      return { ...base, action: "click", value1: locator };
    }
  }

  if (ts.isIdentifier(receiver) && receiver.text === "cerberus" && method === "calculateProperty") {
    const value = stringArg(call, 0);
    if (value === undefined) {
      issues.push({
        file: source.fileName,
        line: sourceLine(source, call),
        message: "cerberus.calculateProperty() requires a literal property name.",
      });
      return undefined;
    }
    return { ...base, action: "calculateProperty", value1: value };
  }

  return undefined;
}

function applyDslMetadata(action: TestAction, metadata: Record<string, unknown>): TestAction {
  const result = { ...action };

  if (typeof metadata.description === "string") result.description = metadata.description;
  if (typeof metadata.condition === "string") result.conditionOperator = metadata.condition;
  if (typeof metadata.fatal === "boolean") result.isFatal = metadata.fatal;
  if (typeof metadata.waitBefore === "number") result.waitBefore = metadata.waitBefore;
  if (typeof metadata.waitAfter === "number") result.waitAfter = metadata.waitAfter;

  if (typeof metadata.screenshot === "string") {
    result.doScreenshotBefore = metadata.screenshot === "before" || metadata.screenshot === "both";
    result.doScreenshotAfter = metadata.screenshot === "after" || metadata.screenshot === "both";
  }

  return result;
}

function parseActionCall(
  call: ts.CallExpression,
  source: ts.SourceFile,
  template: TestAction | undefined,
  issues: ValidationIssue[]
): TestAction | undefined {
  if (!ts.isPropertyAccessExpression(call.expression)) return undefined;

  const receiver = call.expression.expression;
  const method = call.expression.name.text;

  if (ts.isIdentifier(receiver) && receiver.text === "cerberus" && method === "do") {
    const inner = call.arguments[0];
    if (!inner || !ts.isCallExpression(inner)) {
      issues.push({
        file: source.fileName,
        line: sourceLine(source, call),
        message: "cerberus.do() requires a Playwright/Cerberus call as first argument.",
      });
      return undefined;
    }

    const action = parseMappedCall(inner, source, template, issues);
    if (!action) {
      issues.push({
        file: source.fileName,
        line: sourceLine(source, inner),
        message: `Unsupported expression inside cerberus.do(): ${inner.expression.getText(source)}`,
      });
      return undefined;
    }

    return applyDslMetadata(action, parseObjectExpression(call.arguments[1]));
  }

  const mapped = parseMappedCall(call, source, template, issues);
  if (mapped) return mapped;

  if (ts.isIdentifier(receiver) && receiver.text === "cerberus" && method === "action") {
    const actionName = stringArg(call, 0);
    if (!actionName) {
      issues.push({
        file: source.fileName,
        line: sourceLine(source, call),
        message: "cerberus.action() requires a literal action name.",
      });
      return undefined;
    }
    return { ...baseAction(template), ...parseObjectArg(call, 1), action: actionName } as TestAction;
  }

  issues.push({
    file: source.fileName,
    line: sourceLine(source, call),
    message:
      ts.isIdentifier(receiver) && receiver.text === "request"
        ? `Playwright request.* is reserved but this HTTP call has no Cerberus mapping yet: ${call.expression.getText(source)}`
        : `Unsupported Cerberus DSL expression: ${call.expression.getText(source)}`,
  });
  return undefined;
}

export function parseSpec(
  specPath: string,
  original: TestCaseDetailed
): { steps: TestCaseStep[]; issues: ValidationIssue[] } {
  const text = fs.readFileSync(specPath, "utf8");
  const source = ts.createSourceFile(specPath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const issues: ValidationIssue[] = [];
  const steps: TestCaseStep[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "cerberus" &&
      node.expression.name.text === "step"
    ) {
      const description = stringArg(node, 0) ?? `Step ${steps.length + 1}`;
      const callback = node.arguments[1];

      if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) || !ts.isBlock(callback.body)) {
        issues.push({
          file: specPath,
          line: sourceLine(source, node),
          message: "cerberus.step() requires an inline function.",
        });
        return;
      }

      const originalStep = original.steps?.[steps.length];
      const actions: TestAction[] = [];

      for (const statement of callback.body.statements) {
        if (!ts.isExpressionStatement(statement)) continue;
        let expression: ts.Expression = statement.expression;
        if (ts.isAwaitExpression(expression)) expression = expression.expression;
        if (!ts.isCallExpression(expression)) continue;

        if (
          ts.isPropertyAccessExpression(expression.expression) &&
          ts.isIdentifier(expression.expression.expression) &&
          expression.expression.expression.text === "cerberus" &&
          expression.expression.name.text === "control"
        ) {
          const lastAction = actions[actions.length - 1];
          if (!lastAction) {
            issues.push({
              file: specPath,
              line: sourceLine(source, expression),
              message: "cerberus.control() must follow an action.",
            });
            continue;
          }

          const controlName = stringArg(expression, 0);
          if (!controlName) {
            issues.push({
              file: specPath,
              line: sourceLine(source, expression),
              message: "cerberus.control() requires a literal control name.",
            });
            continue;
          }

          const existing =
            originalStep?.actions?.[actions.length - 1]?.controls?.[lastAction.controls?.length ?? 0];

          const control: TestControl = {
            ...(existing ?? {
              testFolderId: lastAction.testFolderId,
              testcaseId: lastAction.testcaseId,
              stepId: lastAction.stepId,
              actionId: lastAction.actionId,
              controlId: (lastAction.controls?.length ?? 0) + 1,
              sort: (lastAction.controls?.length ?? 0) + 1,
              conditionOperator: "always",
              control: controlName,
              isFatal: false,
              doScreenshotBefore: false,
              doScreenshotAfter: false,
              waitBefore: 0,
              waitAfter: 0,
            }),
            ...parseObjectArg(expression, 1),
            control: controlName,
          } as TestControl;

          lastAction.controls = [...(lastAction.controls ?? []), control];
          continue;
        }

        const action = parseActionCall(
          expression,
          source,
          originalStep?.actions?.[actions.length],
          issues
        );
        if (!action) continue;

        action.sort = actions.length + 1;
        action.controls = [];
        actions.push(action);
      }

      steps.push({
        ...(originalStep ?? {
          testFolderId: original.testFolderId,
          testcaseId: original.testcaseId,
          stepId: steps.length + 1,
          sort: steps.length + 1,
          loop: "onceIfConditionTrue",
          conditionOperator: "always",
          isUsingLibraryStep: false,
          libraryStepStepId: 0,
          isStepInUseByOtherTestcase: false,
          libraryStepSort: 0,
          isLibraryStep: false,
          isExecutionForced: false,
          actions: [],
        }),
        description,
        sort: steps.length + 1,
        actions,
      });

      return;
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
  return { steps, issues };
}

export function readLocalTest(testDir: string): { data: TestCaseDetailed; issues: ValidationIssue[] } {
  const metadataPath = path.join(testDir, "cerberus.yaml");
  const specPath = path.join(testDir, "test.spec.ts");
  const statePath = path.join(testDir, ".cerberus", "state.json");

  if (!fs.existsSync(metadataPath)) throw new Error(`Missing ${metadataPath}`);
  if (!fs.existsSync(specPath)) throw new Error(`Missing ${specPath}`);
  if (!fs.existsSync(statePath)) throw new Error(`Missing ${statePath}; run cerberus pull first.`);

  const metadata = YAML.parse(fs.readFileSync(metadataPath, "utf8")) as LocalMetadata;
  const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as LocalState;

  if (metadata.formatVersion !== 1 || state.formatVersion !== 1) {
    throw new Error(`Unsupported local format in ${testDir}`);
  }

  const data: TestCaseDetailed = {
    ...state.serverPayload,
    testFolderId: metadata.testFolder,
    testcaseId: metadata.testcase,
    application: metadata.application,
    description: metadata.description,
    detailedDescription: metadata.detailedDescription,
    priority: metadata.priority,
    status: metadata.status,
    type: metadata.type,
    isActive: metadata.active?.default ?? state.serverPayload.isActive,
    isActiveQA: metadata.active?.QA ?? state.serverPayload.isActiveQA,
    isActiveUAT: metadata.active?.UAT ?? state.serverPayload.isActiveUAT,
    isActivePROD: metadata.active?.PROD ?? state.serverPayload.isActivePROD,
    conditionOperator: metadata.conditionOperator ?? state.serverPayload.conditionOperator,
    properties: Array.isArray(metadata.properties)
      ? (metadata.properties as TestCaseDetailed["properties"])
      : state.serverPayload.properties,
  };

  const parsed = parseSpec(specPath, data);
  data.steps = parsed.steps;
  return { data, issues: parsed.issues };
}

export function findLocalTestDirs(baseDir: string): string[] {
  if (!fs.existsSync(baseDir)) return [];

  const result: string[] = [];

  for (const folder of fs.readdirSync(baseDir, { withFileTypes: true })) {
    if (!folder.isDirectory() || folder.name.startsWith(".")) continue;

    const folderPath = path.join(baseDir, folder.name);
    for (const testcase of fs.readdirSync(folderPath, { withFileTypes: true })) {
      if (!testcase.isDirectory() || testcase.name.startsWith(".")) continue;

      const testDir = path.join(folderPath, testcase.name);
      if (
        fs.existsSync(path.join(testDir, "cerberus.yaml")) &&
        fs.existsSync(path.join(testDir, "test.spec.ts"))
      ) {
        result.push(testDir);
      }
    }
  }

  return result;
}
