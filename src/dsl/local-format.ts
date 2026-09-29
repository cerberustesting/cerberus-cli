import fs from "fs";
import path from "path";
import ts from "typescript";
import type {
  TestAction,
  TestCaseCountry,
  TestCaseDetailed,
  TestCaseLabel,
  TestCaseProperty,
  TestCaseStep,
  TestControl,
} from "../types.js";

export interface LocalState {
  formatVersion: 1;
  serverPayload: TestCaseDetailed;
}

export interface ValidationIssue {
  file: string;
  line?: number;
  message: string;
}

type Chain = {
  namespace: string;
  method: string;
  args: ts.NodeArray<ts.Expression>;
  modifiers: Array<{ method: string; args: ts.NodeArray<ts.Expression> }>;
};

const PROPERTY_FACTORY_BY_TYPE: Record<string, string> = {
  text: "text",
  getFromJson: "fromJson",
  getRawFromJson: "rawFromJson",
  getFromSql: "fromSql",
  getFromDataLib: "fromDataLib",
  getFromJS: "fromJS",
  getFromXml: "fromXml",
  getRawFromXml: "rawFromXml",
  getDifferencesFromXml: "differencesFromXml",
  getFromHtml: "fromHtml",
  getFromHtmlVisible: "fromHtmlVisible",
  getAttributeFromHtml: "attributeFromHtml",
  getFromCookie: "fromCookie",
  getFromNetworkTraffic: "fromNetworkTraffic",
  getFromGroovy: "fromGroovy",
  getFromCommand: "fromCommand",
  getElementPosition: "elementPosition",
  getOTP: "otp",
  getFromExecutionObject: "fromExecutionObject",
};

const PROPERTY_TYPE_BY_FACTORY = Object.fromEntries(
  Object.entries(PROPERTY_FACTORY_BY_TYPE).map(([type, factory]) => [factory, type])
) as Record<string, string>;

function literal(value: unknown): string {
  return JSON.stringify(value ?? "");
}

function hasText(value: unknown): boolean {
  return value !== undefined && value !== null && String(value) !== "";
}

function isTrue(value: boolean | "Y" | "N" | undefined): boolean {
  return value === true || value === "Y";
}

function sourceLine(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function parseLiteral(value: ts.Expression | undefined): unknown {
  if (!value) return undefined;
  if (ts.isStringLiteralLike(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
  if (ts.isNumericLiteral(value)) return Number(value.text);
  if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (value.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (value.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isPrefixUnaryExpression(value) && value.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(value.operand)) {
    return -Number(value.operand.text);
  }
  if (ts.isArrayLiteralExpression(value)) {
    const values = value.elements.map((item) => parseLiteral(item as ts.Expression));
    return values.every((item) => item !== undefined) ? values : undefined;
  }
  return undefined;
}

function propertyName(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined;
}

function findProperty(obj: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment | undefined {
  return obj.properties.find(
    (prop): prop is ts.PropertyAssignment =>
      ts.isPropertyAssignment(prop) && propertyName(prop.name) === name
  );
}

function decomposeChain(expression: ts.Expression): Chain | undefined {
  const modifiers: Array<{ method: string; args: ts.NodeArray<ts.Expression> }> = [];
  let current = expression;

  while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
    const receiver = current.expression.expression;
    const method = current.expression.name.text;

    if (ts.isIdentifier(receiver)) {
      return { namespace: receiver.text, method, args: current.arguments, modifiers: modifiers.reverse() };
    }

    modifiers.push({ method, args: current.arguments });
    if (!ts.isCallExpression(receiver)) return undefined;
    current = receiver;
  }

  return undefined;
}

function parseObjectRef(expression: ts.Expression | undefined): string | undefined {
  if (!expression || !ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression)) return undefined;
  if (expression.expression.text !== "object") return undefined;
  const value = parseLiteral(expression.arguments[0]);
  return typeof value === "string" && value ? `%object.${value}.value%` : undefined;
}

function parsePropertyRef(expression: ts.Expression | undefined): string | undefined {
  if (!expression || !ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression)) return undefined;
  if (!ts.isIdentifier(expression.expression.expression) || expression.expression.expression.text !== "property") return undefined;
  if (expression.expression.name.text !== "value") return undefined;
  const value = parseLiteral(expression.arguments[0]);
  return typeof value === "string" && value ? `%property.${value}%` : undefined;
}

function parseDataLibRef(expression: ts.Expression | undefined): string | undefined {
  if (!expression || !ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression)) return undefined;
  if (!ts.isIdentifier(expression.expression.expression) || expression.expression.expression.text !== "datalib") return undefined;
  if (expression.expression.name.text !== "value") return undefined;
  const name = parseLiteral(expression.arguments[0]);
  const subData = parseLiteral(expression.arguments[1]);
  return typeof name === "string" && typeof subData === "string"
    ? `%datalib.${name}.${subData}%`
    : undefined;
}

function parseDslValue(expression: ts.Expression | undefined): string | undefined {
  const ref = parseObjectRef(expression) ?? parsePropertyRef(expression) ?? parseDataLibRef(expression);
  if (ref !== undefined) return ref;
  const value = parseLiteral(expression);
  return value === undefined ? undefined : String(value);
}

function renderDslValue(value: unknown): string {
  const text = String(value ?? "");
  const property = text.match(/^%property\.([^.]+)%$/);
  if (property) return `property.value(${literal(property[1])})`;

  const datalib = text.match(/^%datalib\.([^.]+)\.([^.]+)%$/);
  if (datalib) return `datalib.value(${literal(datalib[1])}, ${literal(datalib[2])})`;

  const object = text.match(/^%object\.([^.]+)\.value%$/);
  if (object) return `object(${literal(object[1])})`;

  return literal(value);
}

function renderActionModifiers(action: TestAction | TestControl): string {
  let out = "";
  if (hasText(action.description)) out += `.description(${literal(action.description)})`;
  if (hasText(action.conditionOperator) && action.conditionOperator !== "always") {
    out += `.condition(${literal(action.conditionOperator)})`;
  }
  if (action.isFatal !== undefined && !isTrue(action.isFatal)) out += ".fatal(false)";

  const before = isTrue(action.doScreenshotBefore);
  const after = isTrue(action.doScreenshotAfter);
  if (before && after) out += '.screenshot("both")';
  else if (before) out += '.screenshot("before")';
  else if (after) out += '.screenshot("after")';

  if (Number(action.waitBefore ?? 0) !== 0) out += `.waitBefore(${Number(action.waitBefore)})`;
  if (Number(action.waitAfter ?? 0) !== 0) out += `.waitAfter(${Number(action.waitAfter)})`;
  return out;
}

function actionBaseExpression(action: TestAction): string {
  switch (action.action) {
    case "openUrl":
      return `action.openUrl(${renderDslValue(action.value1)})`;
    case "type":
      return `action.feedField(${renderDslValue(action.value1)}, ${renderDslValue(action.value2)})`;
    case "click":
      return `action.click(${renderDslValue(action.value1)})`;
    case "wait":
      return `action.wait(${Number.isFinite(Number(action.value1)) ? Number(action.value1) : renderDslValue(action.value1)})`;
    case "executeJS":
      return `action.executeJS(${literal(action.value1)})`;
    case "calculateProperty":
      return `action.calculateProperty(${literal(action.value1)})`;
    case "callService": {
      const args = [literal(action.value1)];
      if (hasText(action.value2) || hasText(action.value3)) {
        args.push(JSON.stringify({
          ...(hasText(action.value2) ? { kafkaEvents: action.value2 } : {}),
          ...(hasText(action.value3) ? { kafkaWaitSeconds: action.value3 } : {}),
        }));
      }
      return `action.callService(${args.join(", ")})`;
    }
    default: {
      const values: string[] = [];
      if (hasText(action.value1)) values.push(`value1: ${renderDslValue(action.value1)}`);
      if (hasText(action.value2)) values.push(`value2: ${renderDslValue(action.value2)}`);
      if (hasText(action.value3)) values.push(`value3: ${renderDslValue(action.value3)}`);
      return `action.custom(${literal(action.action)}, { ${values.join(", ")} })`;
    }
  }
}

function renderAction(action: TestAction, indent = "      "): string[] {
  const lines = [`${indent}${actionBaseExpression(action)}${renderActionModifiers(action)};`];

  for (const control of action.controls ?? []) {
    const args = [control.value1, control.value2, control.value3]
      .map((v) => hasText(v) ? renderDslValue(v) : undefined);
    while (args.length && args[args.length - 1] === undefined) args.pop();

    const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(control.control);
    const base = identifier
      ? `control.${control.control}(${args.filter((x): x is string => x !== undefined).join(", ")})`
      : `control.custom(${literal(control.control)}, { ${["value1", "value2", "value3"]
          .map((key, i) => args[i] !== undefined ? `${key}: ${args[i]}` : "")
          .filter(Boolean)
          .join(", ")} })`;
    lines.push(`${indent}${base}${renderActionModifiers(control)};`);
  }

  return lines;
}

function normalizedNature(value: unknown): string | undefined {
  if (!hasText(value)) return undefined;
  return String(value).toUpperCase();
}

function renderPropertyDefinition(property: TestCaseProperty): string {
  const type = String(property.type ?? "text");
  const factory = PROPERTY_FACTORY_BY_TYPE[type];

  if (!factory) {
    const detail: Record<string, unknown> = { type };
    for (const key of ["value1", "value2", "value3", "database", "length", "rowLimit", "nature", "rank", "retryNb", "retryPeriod", "cacheExpire", "description"] as const) {
      const value = property[key];
      if (value !== undefined && value !== null && String(value) !== "") detail[key] = value;
    }
    return JSON.stringify(detail);
  }

  const first = hasText(property.value1) ? literal(property.value1) : "";
  let expression = `property.${factory}(${first})`;

  const modifiers: Array<[string, unknown]> = [
    ["value2", property.value2],
    ["value3", property.value3],
    ["database", property.database],
    ["length", property.length],
    ["rowLimit", property.rowLimit],
    ["nature", normalizedNature(property.nature)],
    ["rank", property.rank],
    ["retryNb", property.retryNb],
    ["retryPeriod", property.retryPeriod],
    ["cacheExpire", property.cacheExpire],
    ["description", property.description],
  ];

  for (const [method, value] of modifiers) {
    if (value === undefined || value === null || String(value) === "") continue;
    if (["rowLimit", "rank", "retryNb", "retryPeriod", "cacheExpire"].includes(method) && Number(value) === 0) continue;
    if (method === "nature" && String(value).toUpperCase() === "STATIC") continue;
    const rendered = method === "length" && /^-?\d+$/.test(String(value)) ? String(Number(value)) : literal(value);
    expression += `.${method}(${rendered})`;
  }

  const countries = (property.countries ?? []).map((country) => country.value).filter(Boolean);
  if (countries.length === 1) expression += `.country(${literal(countries[0])})`;
  else if (countries.length > 1) expression += `.countries(${countries.map(literal).join(", ")})`;

  return expression;
}

function renderProperties(test: TestCaseDetailed, indent = "    "): string[] {
  const properties = test.properties ?? [];
  if (!properties.length) return [];

  const lines = [`${indent}property.define({`];
  properties.forEach((property, index) => {
    lines.push(
      `${indent}  ${JSON.stringify(property.property)}: ${renderPropertyDefinition(property)}${index < properties.length - 1 ? "," : ""}`
    );
  });
  lines.push(`${indent}});`, "");
  return lines;
}

function activeList(test: TestCaseDetailed): string[] {
  const values: string[] = [];
  if (test.isActiveQA) values.push("QA");
  if (test.isActiveUAT) values.push("UAT");
  if (test.isActivePROD) values.push("PROD");
  return values;
}

export function generateSpec(test: TestCaseDetailed): string {
  const labels = [...new Set((test.labels ?? []).map((label) => label.label).filter(Boolean))];
  const countries = [...new Set(((test as TestCaseDetailed & { countries?: TestCaseCountry[] }).countries ?? []).map((c) => c.value).filter(Boolean))];

  const header: string[] = [
    `  name: ${literal(test.description || test.testcaseId)},`,
    `  application: ${literal(test.application)},`,
  ];
  if (labels.length) header.push(`  tags: ${JSON.stringify(labels)},`);
  if (countries.length) header.push(`  countries: ${JSON.stringify(countries)},`);
  if (String(test.priority) !== "1") header.push(`  priority: ${literal(test.priority)},`);
  if (test.status && test.status !== "WORKING") header.push(`  status: ${literal(test.status)},`);
  if (test.type && test.type !== "AUTOMATED") header.push(`  type: ${literal(test.type)},`);
  if (hasText(test.detailedDescription)) header.push(`  detailedDescription: ${literal(test.detailedDescription)},`);
  if (!(test.isActive && test.isActiveQA && test.isActiveUAT && test.isActivePROD)) {
    header.push(`  active: ${JSON.stringify(activeList(test))},`);
  }

  const lines = [
    "// Generated by Cerberus CLI.",
    "// Declarative Cerberus DSL: this file is parsed by the CLI and is not executed.",
    "",
    "cerberus.testcase({",
    ...header,
    "",
    "  script: ({ step, action, control, property, object, datalib }) => {",
  ];

  lines.push(...renderProperties(test, "    "));

  for (const step of test.steps ?? []) {
    if (step.isUsingLibraryStep) {
      lines.push(
        `    step.library(${JSON.stringify({
          testFolder: step.libraryStepTestFolderId ?? "",
          testcase: step.libraryStepTestcaseId ?? "",
          step: step.libraryStepStepId,
          ...(hasText(step.description) ? { description: step.description } : {}),
        })});`,
        ""
      );
      continue;
    }

    lines.push(`    step(${literal(step.description || `Step ${step.stepId}`)}, () => {`);
    for (const action of [...(step.actions ?? [])].sort((a, b) => Number(a.sort) - Number(b.sort))) {
      lines.push(...renderAction(action));
    }
    lines.push("    });", "");
  }

  lines.push("  }", "});", "");
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

function baselinePath(testDir: string): string {
  return path.join(testDir, ".sync", "baseline.json");
}

export function migrateLegacyTestLayout(testDir: string): void {
  const legacySync = path.join(testDir, ".cerberus");
  const syncDir = path.join(testDir, ".sync");
  if (fs.existsSync(legacySync) && !fs.existsSync(syncDir)) fs.renameSync(legacySync, syncDir);

  const oldState = path.join(syncDir, "state.json");
  const baseline = baselinePath(testDir);
  if (fs.existsSync(oldState) && !fs.existsSync(baseline)) fs.renameSync(oldState, baseline);
}

export function writeLocalTest(testDir: string, test: TestCaseDetailed): void {
  fs.mkdirSync(path.join(testDir, ".sync"), { recursive: true });
  fs.writeFileSync(path.join(testDir, "testcase.ts"), generateSpec(test), "utf8");
  const state: LocalState = { formatVersion: 1, serverPayload: test };
  fs.writeFileSync(baselinePath(testDir), JSON.stringify(state, null, 2) + "\n", "utf8");
}

function parsePropertyBuilder(expression: ts.Expression): { type: string; values: Record<string, unknown> } | undefined {
  const chain = decomposeChain(expression);
  if (!chain || chain.namespace !== "property" || !PROPERTY_TYPE_BY_FACTORY[chain.method]) return undefined;

  const values: Record<string, unknown> = {};
  const type = PROPERTY_TYPE_BY_FACTORY[chain.method];
  const primary = parseLiteral(chain.args[0]);
  if (primary !== undefined) values.value1 = String(primary);
  else if (type === "text") values.value1 = "";

  for (const modifier of chain.modifiers) {
    if (modifier.method === "country" || modifier.method === "countries") {
      const countries = modifier.args
        .map((arg) => parseLiteral(arg))
        .filter((value) => value !== undefined)
        .map(String);
      values.countries = countries;
      continue;
    }
    const value = parseLiteral(modifier.args[0]);
    if (value !== undefined) values[modifier.method] = value;
  }

  if (values.nature !== undefined) values.nature = normalizedNature(values.nature);
  if (values.length !== undefined) values.length = String(values.length);
  return { type, values };
}

function propertyTemplate(original: TestCaseDetailed, name: string, index: number): TestCaseProperty {
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
    rowLimit: 0,
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
): TestCaseProperty | undefined {
  const base = propertyTemplate(original, name, index);
  const literalValue = parseLiteral(expression);
  if (literalValue !== undefined && !Array.isArray(literalValue)) {
    return { ...base, type: "text", value1: String(literalValue) };
  }

  const builder = parsePropertyBuilder(expression);
  if (!builder) {
    issues.push({ file: source.fileName, line: sourceLine(source, expression), message: `Unsupported property definition for ${name}.` });
    return undefined;
  }

  if (builder.type !== "text" && !hasText(builder.values.value1)) {
    issues.push({ file: source.fileName, line: sourceLine(source, expression), message: `Property ${name}: ${builder.type} requires a primary value.` });
    return undefined;
  }
  if (builder.type === "getFromSql" && !hasText(builder.values.database)) {
    issues.push({ file: source.fileName, line: sourceLine(source, expression), message: `Property ${name}: property.fromSql(...) requires .database("...").` });
    return undefined;
  }

  const countryValues = Array.isArray(builder.values.countries)
    ? builder.values.countries.map(String)
    : undefined;
  const countries = countryValues
    ? countryValues.map((value) => (base.countries ?? []).find((c) => c.value === value) ?? { value })
    : base.countries;

  const { countries: _countries, ...values } = builder.values;
  return { ...base, ...values, countries, property: name, type: builder.type } as TestCaseProperty;
}

function parseProperties(
  body: ts.Block,
  source: ts.SourceFile,
  original: TestCaseDetailed,
  issues: ValidationIssue[]
): TestCaseProperty[] | undefined {
  for (const statement of body.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
    const call = statement.expression;
    if (!ts.isPropertyAccessExpression(call.expression)) continue;
    if (!ts.isIdentifier(call.expression.expression) || call.expression.expression.text !== "property") continue;
    if (call.expression.name.text !== "define") continue;

    const arg = call.arguments[0];
    if (!arg || !ts.isObjectLiteralExpression(arg)) {
      issues.push({ file: source.fileName, line: sourceLine(source, call), message: "property.define() requires an object literal." });
      return [];
    }

    const result: TestCaseProperty[] = [];
    for (const item of arg.properties) {
      if (!ts.isPropertyAssignment(item)) continue;
      const name = propertyName(item.name);
      if (!name) continue;
      const parsed = parsePropertyDefinition(name, item.initializer, source, original, result.length, issues);
      if (parsed) result.push(parsed);
    }
    return result;
  }
  return undefined;
}

function baseAction(template?: TestAction): TestAction {
  return template
    ? { ...template, controls: [] }
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

function baseControl(template?: TestControl): TestControl {
  return template
    ? { ...template }
    : {
        testFolderId: "",
        testcaseId: "",
        stepId: 0,
        actionId: 0,
        controlId: 0,
        sort: 0,
        conditionOperator: "always",
        control: "",
        isFatal: false,
        doScreenshotBefore: false,
        doScreenshotAfter: false,
        waitBefore: 0,
        waitAfter: 0,
      };
}

function applyModifiers<T extends TestAction | TestControl>(target: T, modifiers: Chain["modifiers"]): T {
  for (const modifier of modifiers) {
    const value = parseLiteral(modifier.args[0]);
    switch (modifier.method) {
      case "description": if (value !== undefined) target.description = String(value); break;
      case "condition": if (value !== undefined) target.conditionOperator = String(value); break;
      case "fatal": if (typeof value === "boolean") target.isFatal = value; break;
      case "waitBefore": if (value !== undefined) target.waitBefore = Number(value); break;
      case "waitAfter": if (value !== undefined) target.waitAfter = Number(value); break;
      case "screenshot": {
        const mode = String(value ?? "");
        target.doScreenshotBefore = mode === "before" || mode === "both";
        target.doScreenshotAfter = mode === "after" || mode === "both";
        break;
      }
      case "value1": target.value1 = parseDslValue(modifier.args[0]) ?? ""; break;
      case "value2": target.value2 = parseDslValue(modifier.args[0]) ?? ""; break;
      case "value3": target.value3 = parseDslValue(modifier.args[0]) ?? ""; break;
    }
  }
  return target;
}

function parseOptionsObject(expression: ts.Expression | undefined): Record<string, string> {
  if (!expression || !ts.isObjectLiteralExpression(expression)) return {};
  const result: Record<string, string> = {};
  for (const item of expression.properties) {
    if (!ts.isPropertyAssignment(item)) continue;
    const name = propertyName(item.name);
    if (!name) continue;
    const value = parseDslValue(item.initializer);
    if (value !== undefined) result[name] = value;
  }
  return result;
}

function parseAction(
  expression: ts.Expression,
  template: TestAction | undefined,
  source: ts.SourceFile,
  issues: ValidationIssue[]
): TestAction | undefined {
  const chain = decomposeChain(expression);
  if (!chain || chain.namespace !== "action") return undefined;

  const action = baseAction(template);
  const arg = (index: number) => parseDslValue(chain.args[index]);

  switch (chain.method) {
    case "openUrl": action.action = "openUrl"; action.value1 = arg(0); break;
    case "feedField": action.action = "type"; action.value1 = arg(0); action.value2 = arg(1); break;
    case "click": action.action = "click"; action.value1 = arg(0); break;
    case "wait": action.action = "wait"; action.value1 = arg(0); break;
    case "executeJS": action.action = "executeJS"; action.value1 = arg(0); break;
    case "calculateProperty": action.action = "calculateProperty"; action.value1 = arg(0); break;
    case "callService": {
      action.action = "callService";
      action.value1 = arg(0);
      const options = parseOptionsObject(chain.args[1]);
      action.value2 = options.kafkaEvents ?? "";
      action.value3 = options.kafkaWaitSeconds ?? "";
      break;
    }
    case "custom": {
      const name = parseLiteral(chain.args[0]);
      if (typeof name !== "string" || !name) {
        issues.push({ file: source.fileName, line: sourceLine(source, expression), message: "action.custom() requires a literal action name." });
        return undefined;
      }
      action.action = name;
      const values = parseOptionsObject(chain.args[1]);
      action.value1 = values.value1 ?? "";
      action.value2 = values.value2 ?? "";
      action.value3 = values.value3 ?? "";
      break;
    }
    default: {
      action.action = chain.method;
      action.value1 = arg(0) ?? "";
      action.value2 = arg(1) ?? "";
      action.value3 = arg(2) ?? "";
    }
  }

  if (!action.action) return undefined;
  return applyModifiers(action, chain.modifiers);
}

function parseControl(
  expression: ts.Expression,
  template: TestControl | undefined,
  source: ts.SourceFile,
  issues: ValidationIssue[]
): TestControl | undefined {
  const chain = decomposeChain(expression);
  if (!chain || chain.namespace !== "control") return undefined;

  const control = baseControl(template);
  if (chain.method === "custom") {
    const name = parseLiteral(chain.args[0]);
    if (typeof name !== "string" || !name) {
      issues.push({ file: source.fileName, line: sourceLine(source, expression), message: "control.custom() requires a literal control name." });
      return undefined;
    }
    control.control = name;
    const values = parseOptionsObject(chain.args[1]);
    control.value1 = values.value1 ?? "";
    control.value2 = values.value2 ?? "";
    control.value3 = values.value3 ?? "";
  } else {
    control.control = chain.method;
    control.value1 = parseDslValue(chain.args[0]) ?? "";
    control.value2 = parseDslValue(chain.args[1]) ?? "";
    control.value3 = parseDslValue(chain.args[2]) ?? "";
  }
  return applyModifiers(control, chain.modifiers);
}

function stepTemplate(original: TestCaseDetailed, index: number): TestCaseStep | undefined {
  return [...(original.steps ?? [])].sort((a, b) => Number(a.sort) - Number(b.sort))[index];
}

function newStep(original: TestCaseDetailed, index: number, description: string): TestCaseStep {
  const existing = stepTemplate(original, index);
  return existing
    ? { ...existing, description, sort: index + 1, actions: [] }
    : {
        testFolderId: original.testFolderId,
        testcaseId: original.testcaseId,
        stepId: index + 1,
        sort: index + 1,
        loop: "onceIfConditionTrue",
        conditionOperator: "always",
        description,
        isUsingLibraryStep: false,
        libraryStepStepId: 0,
        isStepInUseByOtherTestcase: false,
        libraryStepSort: 0,
        isLibraryStep: false,
        isExecutionForced: false,
        actions: [],
      };
}

function parseSteps(
  body: ts.Block,
  source: ts.SourceFile,
  original: TestCaseDetailed,
  issues: ValidationIssue[]
): TestCaseStep[] {
  const steps: TestCaseStep[] = [];

  for (const statement of body.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
    const call = statement.expression;

    if (ts.isPropertyAccessExpression(call.expression) &&
        ts.isIdentifier(call.expression.expression) &&
        call.expression.expression.text === "step" &&
        call.expression.name.text === "library") {
      const arg = call.arguments[0];
      if (!arg || !ts.isObjectLiteralExpression(arg)) continue;
      const get = (name: string) => parseLiteral(findProperty(arg, name)?.initializer);
      const step = newStep(original, steps.length, String(get("description") ?? "Library step"));
      step.isUsingLibraryStep = true;
      step.libraryStepTestFolderId = String(get("testFolder") ?? "");
      step.libraryStepTestcaseId = String(get("testcase") ?? "");
      step.libraryStepStepId = Number(get("step") ?? 0);
      steps.push(step);
      continue;
    }

    if (!ts.isIdentifier(call.expression) || call.expression.text !== "step") continue;
    const description = parseLiteral(call.arguments[0]);
    const callback = call.arguments[1];
    if (typeof description !== "string" || !(callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) || !ts.isBlock(callback.body)) {
      issues.push({ file: source.fileName, line: sourceLine(source, call), message: "step() requires a literal description and a block callback." });
      continue;
    }

    const base = newStep(original, steps.length, description);
    const oldActions = [...(stepTemplate(original, steps.length)?.actions ?? [])].sort((a, b) => Number(a.sort) - Number(b.sort));
    const actions: TestAction[] = [];

    for (const child of callback.body.statements) {
      if (!ts.isExpressionStatement(child)) continue;
      const expression = child.expression;

      const parsedAction = parseAction(expression, oldActions[actions.length], source, issues);
      if (parsedAction) {
        parsedAction.sort = actions.length + 1;
        parsedAction.controls = [];
        actions.push(parsedAction);
        continue;
      }

      const last = actions[actions.length - 1];
      const parsedControl = parseControl(
        expression,
        last ? oldActions[actions.length - 1]?.controls?.[last.controls.length] : undefined,
        source,
        issues
      );
      if (parsedControl) {
        if (!last) {
          issues.push({ file: source.fileName, line: sourceLine(source, expression), message: "A control must follow an action inside the same step." });
          continue;
        }
        parsedControl.sort = last.controls.length + 1;
        last.controls.push(parsedControl);
      }
    }

    base.actions = actions;
    steps.push(base);
  }

  return steps;
}

function labelCatalogForTest(testDir: string): TestCaseLabel[] {
  let current = testDir;
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

function resolveTags(testDir: string, tags: string[], original: TestCaseDetailed, issues: ValidationIssue[], file: string): TestCaseLabel[] {
  const catalog = labelCatalogForTest(testDir);
  const baseline = original.labels ?? [];
  const result: TestCaseLabel[] = [];

  for (const raw of tags) {
    const name = raw.replace(/^@/, "");
    const matches = catalog.filter((label) => label.label.toLowerCase() === name.toLowerCase());
    if (matches.length === 1) { result.push(matches[0]); continue; }
    if (matches.length > 1) {
      issues.push({ file, message: `Ambiguous Cerberus label tag: ${raw}.` });
      continue;
    }
    const previous = baseline.find((label) => label.label.toLowerCase() === name.toLowerCase());
    if (previous) { result.push(previous); continue; }
    issues.push({ file, message: `Unknown Cerberus label tag: ${raw}. Run 'cerberus pull' or use an existing label.` });
  }

  return result;
}

function parseTestcase(testDir: string, source: ts.SourceFile, original: TestCaseDetailed, issues: ValidationIssue[]): TestCaseDetailed {
  let testcaseCall: ts.CallExpression | undefined;

  const visit = (node: ts.Node): void => {
    if (
      !testcaseCall &&
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "cerberus" &&
      node.expression.name.text === "testcase"
    ) {
      testcaseCall = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  if (!testcaseCall) {
    issues.push({ file: source.fileName, message: "Missing cerberus.testcase({...})." });
    return original;
  }

  const arg = testcaseCall.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) {
    issues.push({ file: source.fileName, line: sourceLine(source, testcaseCall), message: "cerberus.testcase() requires an object literal." });
    return original;
  }

  const getLiteral = (name: string) => parseLiteral(findProperty(arg, name)?.initializer);
  const name = getLiteral("name");
  const application = getLiteral("application");
  if (typeof name !== "string" || !name.trim()) issues.push({ file: source.fileName, message: "testcase.name is required." });
  if (typeof application !== "string" || !application.trim()) issues.push({ file: source.fileName, message: "testcase.application is required." });

  const data: TestCaseDetailed & { countries?: TestCaseCountry[] } = {
    ...original,
    description: typeof name === "string" ? name : original.description,
    application: typeof application === "string" ? application : original.application,
  };

  const detailedDescription = getLiteral("detailedDescription");
  if (typeof detailedDescription === "string") data.detailedDescription = detailedDescription;
  const priority = getLiteral("priority");
  if (priority !== undefined) data.priority = priority as string | number;
  const status = getLiteral("status");
  if (typeof status === "string") data.status = status;
  const type = getLiteral("type");
  if (typeof type === "string") data.type = type;

  const active = getLiteral("active");
  if (Array.isArray(active)) {
    const values = active.map(String);
    data.isActive = true;
    data.isActiveQA = values.includes("QA");
    data.isActiveUAT = values.includes("UAT");
    data.isActivePROD = values.includes("PROD");
  }

  const countries = getLiteral("countries");
  if (Array.isArray(countries)) {
    const old = (original as TestCaseDetailed & { countries?: TestCaseCountry[] }).countries ?? [];
    data.countries = countries.map(String).map((value) => old.find((c) => c.value === value) ?? { value });
  }

  const tags = getLiteral("tags");
  if (Array.isArray(tags)) data.labels = resolveTags(testDir, tags.map(String), original, issues, source.fileName);

  const scriptProp = findProperty(arg, "script");
  if (!scriptProp || !(ts.isArrowFunction(scriptProp.initializer) || ts.isFunctionExpression(scriptProp.initializer)) || !ts.isBlock(scriptProp.initializer.body)) {
    issues.push({ file: source.fileName, message: "testcase.script must be a block callback." });
    return data;
  }

  data.properties = parseProperties(scriptProp.initializer.body, source, original, issues) ?? original.properties;
  data.steps = parseSteps(scriptProp.initializer.body, source, original, issues);
  return data;
}

function draftState(testDir: string): LocalState {
  const parts = testDir.split(path.sep);
  const testFolderId = parts[parts.length - 2] ?? "";
  return {
    formatVersion: 1,
    serverPayload: {
      testFolderId,
      testcaseId: "",
      application: "",
      description: path.basename(testDir),
      priority: 1,
      version: 0,
      status: "WORKING",
      isActive: true,
      isActiveQA: true,
      isActiveUAT: true,
      isActivePROD: true,
      conditionOperator: "always",
      type: "AUTOMATED",
      usrCreated: "",
      dateCreated: "",
      steps: [],
      properties: [],
      labels: [],
      countries: [],
    } as TestCaseDetailed,
  };
}

export function readLocalTest(testDir: string): { data: TestCaseDetailed; issues: ValidationIssue[] } {
  migrateLegacyTestLayout(testDir);
  const file = path.join(testDir, "testcase.ts");
  if (!fs.existsSync(file)) throw new Error(`Missing ${file}. Run 'pull' to regenerate the native Cerberus DSL.`);

  const state = fs.existsSync(baselinePath(testDir))
    ? JSON.parse(fs.readFileSync(baselinePath(testDir), "utf8")) as LocalState
    : draftState(testDir);

  const sourceText = fs.readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const syntaxDiagnostics = ts.transpileModule(sourceText, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.Latest,
      module: ts.ModuleKind.ESNext,
    },
  }).diagnostics ?? [];
  const issues: ValidationIssue[] = syntaxDiagnostics.map((diag: ts.Diagnostic) => ({
    file,
    line: diag.start === undefined ? undefined : source.getLineAndCharacterOfPosition(diag.start).line + 1,
    message: ts.flattenDiagnosticMessageText(diag.messageText, "\n"),
  }));

  const data = parseTestcase(testDir, source, state.serverPayload, issues);
  return { data, issues };
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
      migrateLegacyTestLayout(testDir);
      if (fs.existsSync(path.join(testDir, "testcase.ts"))) result.push(testDir);
    }
  }
  return result;
}
