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

function applicationObjectName(value: unknown): string | undefined {
  const match = String(value ?? "").match(/^%object\.([^.]+)\.value%$/);
  return match?.[1];
}

function datalibExpression(value: unknown): string | undefined {
  const match = String(value ?? "").match(/^%datalib\.([^.]+)\.([^.]+)%$/);
  return match ? `cerberus.datalib(${literal(match[1])}).value(${literal(match[2])})` : undefined;
}

function playwrightExpression(action: TestAction): string | undefined {
  switch (action.action) {
    case "openUrl":
      return `page.goto(${literal(action.value1)})`;

    case "type": {
      const objectName = applicationObjectName(action.value1);
      const value = renderDslValue(action.value2);
      return objectName
        ? `cerberus.object(${literal(objectName)}).fill(${value})`
        : `page.locator(${literal(action.value1)}).fill(${value})`;
    }

    case "click": {
      const objectName = applicationObjectName(action.value1);
      return objectName
        ? `cerberus.object(${literal(objectName)}).click()`
        : `page.locator(${literal(action.value1)}).click()`;
    }

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

  if (action.action === "callService") {
    const opts: Record<string, unknown> = {};
    if (hasText(action.value2)) opts.kafkaEvents = action.value2;
    if (hasText(action.value3)) opts.kafkaWaitSeconds = action.value3;
    const expression = Object.keys(opts).length
      ? `cerberus.service(${literal(action.value1)}).call(${JSON.stringify(opts)})`
      : `cerberus.service(${literal(action.value1)}).call()`;
    lines = hasMetadata(metadata)
      ? [`${indent}await cerberus.do(${expression}, ${renderMetadata(metadata)});`]
      : [`${indent}await ${expression};`];
  } else if (action.action === "calculateProperty") {
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
      const options: string[] = [];
      if (action.value1 !== undefined) options.push(`value1: ${renderDslValue(action.value1)}`);
      if (action.value2 !== undefined) options.push(`value2: ${renderDslValue(action.value2)}`);
      if (action.value3 !== undefined) options.push(`value3: ${renderDslValue(action.value3)}`);
      if (action.conditionOperator !== undefined) options.push(`conditionOperator: ${literal(action.conditionOperator)}`);
      if (action.isFatal !== undefined) options.push(`isFatal: ${literal(action.isFatal)}`);
      if (action.doScreenshotBefore !== undefined) options.push(`doScreenshotBefore: ${literal(action.doScreenshotBefore)}`);
      if (action.doScreenshotAfter !== undefined) options.push(`doScreenshotAfter: ${literal(action.doScreenshotAfter)}`);
      if (action.waitBefore !== undefined) options.push(`waitBefore: ${literal(action.waitBefore)}`);
      if (action.waitAfter !== undefined) options.push(`waitAfter: ${literal(action.waitAfter)}`);
      if (action.description !== undefined) options.push(`description: ${literal(action.description)}`);
      lines = [
        `${indent}await cerberus.action(${literal(action.action)}, { ${options.join(", ")} });`,
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
  };
}

function renderPropertyDefinition(property: NonNullable<TestCaseDetailed["properties"]>[number]): string {
  const type = String(property.type ?? "text");
  const value1 = property.value1 ?? "";

  if (type === "text") return literal(value1);
  if (type === "getFromDataLib") return `cerberus.fromDataLib(${literal(value1)})`;
  if (type === "getFromJS" && !hasText(value1) && !hasText(property.value2) && !hasText(property.value3)) {
    return "cerberus.fromJS()";
  }

  const detail: Record<string, unknown> = { type };
  if (hasText(property.value1)) detail.value1 = property.value1;
  if (hasText(property.value2)) detail.value2 = property.value2;
  if (hasText(property.value3)) detail.value3 = property.value3;
  if (hasText(property.length)) detail.length = property.length;
  if (property.rowLimit !== undefined && property.rowLimit !== null) detail.rowLimit = property.rowLimit;
  if (hasText(property.nature)) detail.nature = property.nature;
  if (property.rank !== undefined && property.rank !== null) detail.rank = property.rank;
  return JSON.stringify(detail);
}

function renderProperties(test: TestCaseDetailed): string[] {
  const properties = test.properties ?? [];
  if (!properties.length) return [];

  const lines = ["    cerberus.properties({"];
  properties.forEach((property, index) => {
    const comma = index < properties.length - 1 ? "," : "";
    lines.push(`        ${JSON.stringify(property.property)}: ${renderPropertyDefinition(property)}${comma}`);
  });
  lines.push("    });", "");
  return lines;
}

function propertyExpression(value: unknown): string | undefined {
  const match = String(value ?? "").match(/^%property\.([^.]+)%$/);
  return match ? `cerberus.property(${literal(match[1])})` : undefined;
}

function renderDslValue(value: unknown): string {
  return propertyExpression(value) ?? datalibExpression(value) ?? literal(value);
}

export function generateSpec(test: TestCaseDetailed): string {
  const tags = [...new Set((test.labels ?? [])
    .map((label) => String(label.label ?? "").trim())
    .filter(Boolean)
    .map((label) => label.startsWith("@") ? label : `@${label}`))];

  const options = tags.length ? `, { tag: ${JSON.stringify(tags)} }` : "";
  const lines: string[] = [
    "// Generated by Cerberus CLI.",
    "// Playwright-like DSL interpreted by Cerberus CLI; it is not executed by Playwright.",
    "",
    `test(${literal(test.description || test.testcaseId)}${options}, async ({ page, request, cerberus }) => {`,
  ];

  lines.push(...renderProperties(test));

  for (const step of test.steps ?? []) {
    lines.push("");

    if (step.isUsingLibraryStep) {
      lines.push(
        `    await cerberus.libraryStep(${JSON.stringify({
          testFolder: step.libraryStepTestFolderId ?? "",
          testcase: step.libraryStepTestcaseId ?? "",
          step: step.libraryStepStepId,
          ...(hasText(step.description) ? { description: step.description } : {}),
        })});`
      );
      continue;
    }

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

export function localTestDirName(test: Pick<TestCaseDetailed, "testcaseId" | "description">): string {
  const description = String(test.description ?? "")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 100);

  return description ? `${test.testcaseId} - ${description}` : String(test.testcaseId);
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

function datalibReference(expression: ts.Expression | undefined): string | undefined {
  if (!expression || !ts.isCallExpression(expression)) return undefined;
  if (!ts.isPropertyAccessExpression(expression.expression) || expression.expression.name.text !== "value") return undefined;
  const receiver = expression.expression.expression;
  if (!ts.isCallExpression(receiver) || !ts.isPropertyAccessExpression(receiver.expression)) return undefined;
  if (!ts.isIdentifier(receiver.expression.expression) || receiver.expression.expression.text !== "cerberus") return undefined;
  if (receiver.expression.name.text !== "datalib") return undefined;
  const name = stringArg(receiver, 0);
  const subData = stringArg(expression, 0);
  return name && subData ? `%datalib.${name}.${subData}%` : undefined;
}

function propertyReference(expression: ts.Expression | undefined): string | undefined {
  if (!expression || !ts.isCallExpression(expression)) return undefined;
  if (!ts.isPropertyAccessExpression(expression.expression)) return undefined;
  if (!ts.isIdentifier(expression.expression.expression) || expression.expression.expression.text !== "cerberus") return undefined;
  if (expression.expression.name.text !== "property") return undefined;
  const name = stringArg(expression, 0);
  return name ? `%property.${name}%` : undefined;
}

function dslValueArg(call: ts.CallExpression, index: number): string | undefined {
  return stringArg(call, index) ?? datalibReference(call.arguments[index]) ?? propertyReference(call.arguments[index]);
}

function sourceLine(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function parseLiteral(value: ts.Expression): unknown {
  if (ts.isStringLiteralLike(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
  if (ts.isNumericLiteral(value)) return Number(value.text);
  if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (value.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isArrayLiteralExpression(value)) {
    const parsed = value.elements.map((element) => parseLiteral(element as ts.Expression));
    return parsed.every((item) => item !== undefined) ? parsed : undefined;
  }
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

    const value =
      parseLiteral(prop.initializer) ??
      propertyReference(prop.initializer) ??
      datalibReference(prop.initializer);
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

function cerberusObjectValue(call: ts.CallExpression): string | undefined {
  if (!ts.isPropertyAccessExpression(call.expression)) return undefined;
  const receiver = call.expression.expression;
  if (!ts.isCallExpression(receiver) || !ts.isPropertyAccessExpression(receiver.expression)) return undefined;
  if (!ts.isIdentifier(receiver.expression.expression) || receiver.expression.expression.text !== "cerberus") return undefined;
  if (receiver.expression.name.text !== "object") return undefined;
  const name = stringArg(receiver, 0);
  return name ? `%object.${name}.value%` : undefined;
}

function cerberusServiceName(call: ts.CallExpression): string | undefined {
  if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== "call") return undefined;
  const receiver = call.expression.expression;
  if (!ts.isCallExpression(receiver) || !ts.isPropertyAccessExpression(receiver.expression)) return undefined;
  if (!ts.isIdentifier(receiver.expression.expression) || receiver.expression.expression.text !== "cerberus") return undefined;
  if (receiver.expression.name.text !== "service") return undefined;
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

  const objectValue = cerberusObjectValue(call);
  if (objectValue !== undefined) {
    if (method === "fill") {
      const value = dslValueArg(call, 0);
      if (value === undefined) {
        issues.push({ file: source.fileName, line: sourceLine(source, call), message: "cerberus.object(...).fill() requires a literal value." });
        return undefined;
      }
      return { ...base, action: "type", value1: objectValue, value2: value };
    }
    if (method === "click") {
      return { ...base, action: "click", value1: objectValue };
    }
  }

  const serviceName = cerberusServiceName(call);
  if (serviceName !== undefined) {
    const opts = parseObjectExpression(call.arguments[0]);
    return {
      ...base,
      action: "callService",
      value1: serviceName,
      value2: opts.kafkaEvents !== undefined ? String(opts.kafkaEvents) : "",
      value3: opts.kafkaWaitSeconds !== undefined ? String(opts.kafkaWaitSeconds) : "",
    };
  }

  const locator = locatorValue(call);
  if (locator !== undefined) {
    if (method === "fill") {
      const value = dslValueArg(call, 0);
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

function baseStep(original: TestCaseDetailed, template: TestCaseStep | undefined, index: number): TestCaseStep {
  return template
    ? { ...template, actions: [...(template.actions ?? [])] }
    : {
        testFolderId: original.testFolderId,
        testcaseId: original.testcaseId,
        stepId: index + 1,
        sort: index + 1,
        loop: "onceIfConditionTrue",
        conditionOperator: "always",
        isUsingLibraryStep: false,
        libraryStepStepId: 0,
        isStepInUseByOtherTestcase: false,
        libraryStepSort: 0,
        isLibraryStep: false,
        isExecutionForced: false,
        actions: [],
      };
}

function parseLibraryStepCall(
  call: ts.CallExpression,
  source: ts.SourceFile,
  original: TestCaseDetailed,
  template: TestCaseStep | undefined,
  index: number,
  issues: ValidationIssue[]
): TestCaseStep | undefined {
  const values = parseObjectExpression(call.arguments[0]);
  const testFolder = values.testFolder;
  const testcase = values.testcase;
  const stepId = values.step;

  if (typeof testFolder !== "string" || !testFolder) {
    issues.push({ file: source.fileName, line: sourceLine(source, call), message: "cerberus.libraryStep() requires a literal testFolder." });
    return undefined;
  }
  if (typeof testcase !== "string" || !testcase) {
    issues.push({ file: source.fileName, line: sourceLine(source, call), message: "cerberus.libraryStep() requires a literal testcase." });
    return undefined;
  }
  if (typeof stepId !== "number") {
    issues.push({ file: source.fileName, line: sourceLine(source, call), message: "cerberus.libraryStep() requires a numeric literal step." });
    return undefined;
  }

  const base = baseStep(original, template, index);
  return {
    ...base,
    description:
      typeof values.description === "string"
        ? values.description
        : base.description || `Library step ${testFolder}/${testcase}#${stepId}`,
    sort: index + 1,
    isUsingLibraryStep: true,
    libraryStepTestFolderId: testFolder,
    libraryStepTestcaseId: testcase,
    libraryStepStepId: stepId,
    actions: [],
  };
}

/**
 * Les actions et contrôles créés dans le DSL n'ont pas d'identifiants. Or le serveur identifie chaque élément par sa
 * propre clé (dossier, testcase, stepId, actionId, controlId) et ne la déduit pas du parent : une action à
 * stepId 0 / actionId 0 serait insérée dans un step inexistant et disparaîtrait. On complète donc les clés manquantes,
 * sans jamais changer celles qui existent déjà.
 */
function nextFree(used: Set<number>): number {
  let id = Math.max(0, ...used) + 1;
  while (used.has(id)) id++;
  used.add(id);
  return id;
}

function assignIdentifiers(steps: TestCaseStep[], original: TestCaseDetailed): void {
  const usedSteps = new Set<number>();
  for (const step of steps) {
    step.testFolderId = step.testFolderId || original.testFolderId;
    step.testcaseId = step.testcaseId || original.testcaseId;
    if (step.stepId > 0 && !usedSteps.has(step.stepId)) usedSteps.add(step.stepId);
    else step.stepId = nextFree(usedSteps);
  }

  for (const step of steps) {
    const usedActions = new Set<number>();
    for (const action of step.actions ?? []) {
      action.testFolderId = action.testFolderId || original.testFolderId;
      action.testcaseId = action.testcaseId || original.testcaseId;
      action.stepId = step.stepId;
      if (action.actionId > 0 && !usedActions.has(action.actionId)) usedActions.add(action.actionId);
      else action.actionId = nextFree(usedActions);

      const usedControls = new Set<number>();
      for (const control of action.controls ?? []) {
        control.testFolderId = control.testFolderId || original.testFolderId;
        control.testcaseId = control.testcaseId || original.testcaseId;
        control.stepId = action.stepId;
        control.actionId = action.actionId;
        if (control.controlId > 0 && !usedControls.has(control.controlId)) usedControls.add(control.controlId);
        else control.controlId = nextFree(usedControls);
      }
    }
  }
}

function propertyTemplate(original: TestCaseDetailed, name: string, index: number): NonNullable<TestCaseDetailed["properties"]>[number] {
  const existing = (original.properties ?? []).find((property) => property.property === name);
  if (existing) return { ...existing, countries: [...(existing.countries ?? [])] };
  return {
    testFolderId: original.testFolderId,
    testcaseId: original.testcaseId,
    property: name,
    type: "text",
    value1: "",
    value2: "",
    value3: "",
    nature: "STATIC",
    rank: index + 1,
    dateCreated: "",
    dateModif: "",
    countries: [],
  };
}

function parsePropertyDefinition(
  name: string,
  expression: ts.Expression,
  source: ts.SourceFile,
  original: TestCaseDetailed,
  index: number,
  issues: ValidationIssue[]
): NonNullable<TestCaseDetailed["properties"]>[number] | undefined {
  const base = propertyTemplate(original, name, index);

  if (ts.isStringLiteralLike(expression) || ts.isNoSubstitutionTemplateLiteral(expression) || ts.isNumericLiteral(expression)) {
    return { ...base, type: "text", value1: expression.text };
  }

  if (
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    ts.isIdentifier(expression.expression.expression) &&
    expression.expression.expression.text === "cerberus"
  ) {
    const method = expression.expression.name.text;
    if (method === "fromDataLib") {
      const value = stringArg(expression, 0);
      if (!value) {
        issues.push({ file: source.fileName, line: sourceLine(source, expression), message: `Property ${name}: cerberus.fromDataLib() requires a literal DataLib name.` });
        return undefined;
      }
      return { ...base, type: "getFromDataLib", value1: value };
    }
    if (method === "fromJS") {
      const value = stringArg(expression, 0) ?? "";
      return { ...base, type: "getFromJS", value1: value };
    }
  }

  if (ts.isObjectLiteralExpression(expression)) {
    const detail = parseObjectExpression(expression);
    if (typeof detail.type !== "string" || !detail.type) {
      issues.push({ file: source.fileName, line: sourceLine(source, expression), message: `Property ${name}: detailed form requires a literal type.` });
      return undefined;
    }
    return {
      ...base,
      ...detail,
      property: name,
      type: detail.type,
    } as NonNullable<TestCaseDetailed["properties"]>[number];
  }

  issues.push({
    file: source.fileName,
    line: sourceLine(source, expression),
    message: `Unsupported property definition for ${name}. Use a literal, cerberus.fromDataLib(...), cerberus.fromJS(...), or an object literal.`,
  });
  return undefined;
}

function parsePropertyDefinitions(
  source: ts.SourceFile,
  original: TestCaseDetailed,
  issues: ValidationIssue[]
): NonNullable<TestCaseDetailed["properties"]> | undefined {
  let found: NonNullable<TestCaseDetailed["properties"]> | undefined;

  const visit = (node: ts.Node): void => {
    if (
      !found &&
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "cerberus" &&
      node.expression.name.text === "properties"
    ) {
      const arg = node.arguments[0];
      if (!arg || !ts.isObjectLiteralExpression(arg)) {
        issues.push({ file: source.fileName, line: sourceLine(source, node), message: "cerberus.properties() requires an object literal." });
        found = [];
        return;
      }

      found = [];
      for (const prop of arg.properties) {
        if (!ts.isPropertyAssignment(prop)) {
          issues.push({ file: source.fileName, line: sourceLine(source, prop), message: "cerberus.properties() only supports explicit property assignments." });
          continue;
        }
        const name = ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name) ? prop.name.text : undefined;
        if (!name) {
          issues.push({ file: source.fileName, line: sourceLine(source, prop), message: "Property names must be literal." });
          continue;
        }
        const parsed = parsePropertyDefinition(name, prop.initializer, source, original, found.length, issues);
        if (parsed) found.push(parsed);
      }
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return found;
}

function extractTestTags(source: ts.SourceFile): string[] {
  let tags: string[] = [];

  const visit = (node: ts.Node): void => {
    if (
      tags.length === 0 &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "test" &&
      node.arguments.length >= 3
    ) {
      const options = node.arguments[1];
      if (options && ts.isObjectLiteralExpression(options)) {
        for (const prop of options.properties) {
          if (!ts.isPropertyAssignment(prop)) continue;
          const key = ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name) ? prop.name.text : "";
          if (key !== "tag") continue;
          const value = parseLiteral(prop.initializer);
          const values = Array.isArray(value) ? value : [value];
          tags = values
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.trim())
            .filter(Boolean);
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return tags;
}

function labelCatalogForTest(testDir: string): Array<Record<string, any>> {
  let current = path.resolve(testDir);
  for (let i = 0; i < 6; i++) {
    const file = path.join(current, ".cerberus", "labels.json");
    if (fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        return Array.isArray(parsed.labels) ? parsed.labels : [];
      } catch {
        return [];
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return [];
}

function resolveTags(
  testDir: string,
  tags: string[],
  original: TestCaseDetailed,
  issues: ValidationIssue[],
  specPath: string
): NonNullable<TestCaseDetailed["labels"]> {
  const catalog = labelCatalogForTest(testDir);
  const baseline = original.labels ?? [];
  const labels: NonNullable<TestCaseDetailed["labels"]> = [];

  for (const tag of tags) {
    const name = tag.replace(/^@/, "");
    const matches = catalog.filter((label) => String(label.label ?? "").toLowerCase() === name.toLowerCase());
    const baselineMatch = baseline.find((label) => String(label.label ?? "").toLowerCase() === name.toLowerCase());

    if (matches.length === 1) {
      labels.push(matches[0] as NonNullable<TestCaseDetailed["labels"]>[number]);
      continue;
    }
    if (matches.length === 0 && baselineMatch) {
      labels.push(baselineMatch);
      continue;
    }
    if (matches.length === 0) {
      issues.push({ file: specPath, message: `Unknown Cerberus label tag: ${tag}. Run 'cerberus pull' or use an existing label.` });
      continue;
    }

    issues.push({
      file: specPath,
      message: `Ambiguous Cerberus label tag: ${tag} matches ${matches.length} labels. Use a unique label name before push.`,
    });
  }

  return labels;
}

export function parseSpec(
  specPath: string,
  original: TestCaseDetailed
): { steps: TestCaseStep[]; issues: ValidationIssue[]; tags: string[]; properties?: NonNullable<TestCaseDetailed["properties"]> } {
  const text = fs.readFileSync(specPath, "utf8");
  const source = ts.createSourceFile(specPath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const issues: ValidationIssue[] = [];
  const steps: TestCaseStep[] = [];
  const tags = extractTestTags(source);
  const properties = parsePropertyDefinitions(source, original, issues);

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "cerberus" &&
      node.expression.name.text === "libraryStep"
    ) {
      const libraryStep = parseLibraryStepCall(
        node,
        source,
        original,
        original.steps?.[steps.length],
        steps.length,
        issues
      );
      if (libraryStep) steps.push(libraryStep);
      return;
    }

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

      // generateSpec écrit les actions triées par sort : les identifiants d'origine doivent être relus dans le même ordre
      const rawStep = original.steps?.[steps.length];
      const originalStep = rawStep
        ? { ...rawStep, actions: [...(rawStep.actions ?? [])].sort((a, b) => Number(a.sort) - Number(b.sort)) }
        : undefined;
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
        ...baseStep(original, originalStep, steps.length),
        description,
        sort: steps.length + 1,
        isUsingLibraryStep: false,
        libraryStepTestFolderId: undefined,
        libraryStepTestcaseId: undefined,
        libraryStepStepId: 0,
        actions,
      });

      return;
    }

    ts.forEachChild(node, visit);
  };

  visit(source);

  const findActionsOutsideSteps = (node: ts.Node, insideStep: boolean): void => {
    if (ts.isCallExpression(node)) {
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "cerberus" &&
        node.expression.name.text === "libraryStep"
      ) {
        return;
      }

      if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "cerberus" &&
        node.expression.name.text === "step"
      ) {
        for (const arg of node.arguments) {
          if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
            ts.forEachChild(arg, (child) => findActionsOutsideSteps(child, true));
          }
        }
        return;
      }

      let isDslAction = false;

      if (ts.isPropertyAccessExpression(node.expression)) {
        const receiver = node.expression.expression;

        if (ts.isIdentifier(receiver) && ["page", "request"].includes(receiver.text)) {
          const method = node.expression.name.text;
          const selectorBuilder =
            receiver.text === "page" &&
            ["locator", "getByRole", "getByText", "getByLabel", "getByPlaceholder", "getByTestId", "getByAltText", "getByTitle"].includes(method);
          isDslAction = !selectorBuilder;
        } else if (
          ts.isIdentifier(receiver) &&
          receiver.text === "cerberus" &&
          ["do", "action", "control", "calculateProperty"].includes(node.expression.name.text)
        ) {
          isDslAction = true;
        } else if (
          ts.isCallExpression(receiver) &&
          ts.isPropertyAccessExpression(receiver.expression) &&
          ts.isIdentifier(receiver.expression.expression) &&
          ["page", "cerberus"].includes(receiver.expression.expression.text)
        ) {
          const builder = receiver.expression.name.text;
          isDslAction =
            receiver.expression.expression.text === "page" ||
            ["object", "service"].includes(builder);
        }
      }

      if (isDslAction && !insideStep) {
        issues.push({
          file: specPath,
          line: sourceLine(source, node),
          message:
            "Action outside cerberus.step(...). Run 'cerberus prepare' and group Playwright actions into functional Cerberus steps before push.",
        });
      }
    }

    ts.forEachChild(node, (child) => findActionsOutsideSteps(child, insideStep));
  };

  findActionsOutsideSteps(source, false);

  if (steps.length === 0) {
    issues.push({
      file: specPath,
      message:
        "No Cerberus step found. Pure Playwright is accepted as a draft, but must be enriched with cerberus.step(...) or cerberus.libraryStep(...) before validate/push.",
    });
  }

  assignIdentifiers(steps, original);
  return { steps, issues, tags, properties };
}

function draftStateFromMetadata(testDir: string, metadata: LocalMetadata): LocalState {
  const parts = testDir.split(path.sep);
  const folderFromPath = parts[parts.length - 2] ?? "";
  const testcaseFromPath = parts[parts.length - 1] ?? "";

  const serverPayload: TestCaseDetailed = {
    testFolderId: metadata.testFolder || folderFromPath,
    testcaseId: metadata.testcase || testcaseFromPath,
    application: metadata.application,
    description: metadata.description,
    detailedDescription: metadata.detailedDescription,
    priority: metadata.priority ?? 1,
    version: 0,
    status: metadata.status || "WORKING",
    isActive: metadata.active?.default ?? true,
    isActiveQA: metadata.active?.QA ?? true,
    isActiveUAT: metadata.active?.UAT ?? true,
    isActivePROD: metadata.active?.PROD ?? true,
    conditionOperator: metadata.conditionOperator || "always",
    type: metadata.type || "AUTOMATED",
    usrCreated: "",
    dateCreated: "",
    steps: [],
    properties: Array.isArray(metadata.properties)
      ? (metadata.properties as TestCaseDetailed["properties"])
      : [],
  };

  return { formatVersion: 1, serverPayload };
}

export function readLocalTest(testDir: string): { data: TestCaseDetailed; issues: ValidationIssue[] } {
  const metadataPath = path.join(testDir, "cerberus.yaml");
  const specPath = path.join(testDir, "test.spec.ts");
  const statePath = path.join(testDir, ".cerberus", "state.json");

  if (!fs.existsSync(metadataPath)) throw new Error(`Missing ${metadataPath}`);
  if (!fs.existsSync(specPath)) throw new Error(`Missing ${specPath}`);
  const metadata = YAML.parse(fs.readFileSync(metadataPath, "utf8")) as LocalMetadata;
  const state = fs.existsSync(statePath)
    ? (JSON.parse(fs.readFileSync(statePath, "utf8")) as LocalState)
    : draftStateFromMetadata(testDir, metadata);

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
    properties: state.serverPayload.properties,
  };

  const parsed = parseSpec(specPath, data);
  data.steps = parsed.steps;
  data.properties = parsed.properties ??
    (Array.isArray(metadata.properties)
      ? (metadata.properties as TestCaseDetailed["properties"])
      : state.serverPayload.properties);
  data.labels = resolveTags(testDir, parsed.tags, state.serverPayload, parsed.issues, specPath);
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
