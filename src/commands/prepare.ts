import fs from "fs";
import path from "path";
import ts from "typescript";
import { loadConfig, testsDir } from "../config.js";
import { findLocalTestDirs } from "../dsl/local-format.js";
import { selectTestDirs } from "../sync.js";

export interface PrepareOptions {
  json?: boolean;
}

interface PrepareReport {
  ref: string;
  file: string;
  steps: number;
  playwrightActions: number;
  wrappedActions: number;
  describedActions: number;
  actionsOutsideSteps: number;
  cerberusActions: number;
  ready: boolean;
  suggestions: string[];
}

function isCerberusStep(call: ts.CallExpression): boolean {
  return (
    ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    call.expression.expression.text === "cerberus" &&
    call.expression.name.text === "step"
  );
}

function isCerberusLibraryStep(call: ts.CallExpression): boolean {
  return (
    ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    call.expression.expression.text === "cerberus" &&
    call.expression.name.text === "libraryStep"
  );
}

function isCerberusDo(call: ts.CallExpression): boolean {
  return (
    ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    call.expression.expression.text === "cerberus" &&
    call.expression.name.text === "do"
  );
}

function isCerberusAction(call: ts.CallExpression): boolean {
  return (
    ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    call.expression.expression.text === "cerberus" &&
    ["action", "calculateProperty"].includes(call.expression.name.text)
  );
}

function isCerberusResourceAction(call: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(call.expression)) return false;
  const receiver = call.expression.expression;
  if (!ts.isCallExpression(receiver) || !ts.isPropertyAccessExpression(receiver.expression)) return false;
  return (
    ts.isIdentifier(receiver.expression.expression) &&
    receiver.expression.expression.text === "cerberus" &&
    ["object", "service"].includes(receiver.expression.name.text)
  );
}

function isPageCall(call: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(call.expression)) return false;
  const receiver = call.expression.expression;
  if (ts.isIdentifier(receiver) && receiver.text === "page") {
    const method = call.expression.name.text;
    if (["locator", "getByRole", "getByText", "getByLabel", "getByPlaceholder", "getByTestId", "getByAltText", "getByTitle"].includes(method)) {
      return false;
    }
    return true;
  }

  if (
    ts.isCallExpression(receiver) &&
    ts.isPropertyAccessExpression(receiver.expression) &&
    ts.isIdentifier(receiver.expression.expression) &&
    receiver.expression.expression.text === "page"
  ) {
    return true;
  }
  return false;
}

function metadataHasDescription(call: ts.CallExpression): boolean {
  const arg = call.arguments[1];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return false;
  return arg.properties.some(
    (prop) =>
      ts.isPropertyAssignment(prop) &&
      ((ts.isIdentifier(prop.name) && prop.name.text === "description") ||
        (ts.isStringLiteralLike(prop.name) && prop.name.text === "description")) &&
      ts.isStringLiteralLike(prop.initializer) &&
      prop.initializer.text.trim().length > 0
  );
}

function analyzeSpec(testDir: string): PrepareReport {
  const specPath = path.join(testDir, "test.spec.ts");
  const source = ts.createSourceFile(
    specPath,
    fs.readFileSync(specPath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  let steps = 0;
  let playwrightActions = 0;
  let wrappedActions = 0;
  let describedActions = 0;
  let actionsOutsideSteps = 0;
  let cerberusActions = 0;

  const visit = (node: ts.Node, insideStep: boolean): void => {
    if (ts.isCallExpression(node)) {
      if (isCerberusLibraryStep(node)) {
        steps++;
        return;
      }

      if (isCerberusStep(node)) {
        steps++;
        for (const arg of node.arguments) {
          if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
            ts.forEachChild(arg, (child) => visit(child, true));
          }
        }
        return;
      }

      if (isCerberusDo(node)) {
        wrappedActions++;
        if (metadataHasDescription(node)) describedActions++;

        const inner = node.arguments[0];
        if (inner && ts.isCallExpression(inner) && isPageCall(inner)) {
          playwrightActions++;
          if (!insideStep) actionsOutsideSteps++;
        }
        return;
      }

      if (isPageCall(node)) {
        playwrightActions++;
        if (!insideStep) actionsOutsideSteps++;
      } else if (isCerberusAction(node) || isCerberusResourceAction(node)) {
        cerberusActions++;
        if (!insideStep) actionsOutsideSteps++;
      }
    }

    ts.forEachChild(node, (child) => visit(child, insideStep));
  };

  visit(source, false);

  const suggestions: string[] = [];
  if (steps === 0 && playwrightActions > 0) {
    suggestions.push("Regrouper les actions Playwright par intention métier dans un ou plusieurs cerberus.step(...), ou utiliser cerberus.libraryStep(...) pour une référence de librairie existante.");
  }
  if (actionsOutsideSteps > 0) {
    suggestions.push(`${actionsOutsideSteps} action(s) sont hors d'un cerberus.step(...).`);
  }
  if (playwrightActions > describedActions) {
    suggestions.push(
      "Ajouter cerberus.do(..., { description }) uniquement aux actions dont la description apporte une valeur fonctionnelle."
    );
  }
  suggestions.push(
    "Conserver le code Playwright natif quand il existe ; utiliser cerberus.* seulement pour les capacités spécifiques Cerberus."
  );

  return {
    ref: testDir.split(path.sep).slice(-2).join("/"),
    file: specPath,
    steps,
    playwrightActions,
    wrappedActions,
    describedActions,
    actionsOutsideSteps,
    cerberusActions,
    ready: steps > 0 && actionsOutsideSteps === 0,
    suggestions,
  };
}

export async function prepareCommand(refs: string[], opts: PrepareOptions): Promise<number> {
  const config = loadConfig();
  const allDirs = findLocalTestDirs(testsDir(config));
  if (allDirs.length === 0) {
    throw new Error("Aucun testcase local trouvé. Lancez 'pull' ou créez d'abord le dossier du testcase.");
  }

  const dirs = selectTestDirs(allDirs, refs);
  const reports = dirs.map(analyzeSpec);

  if (opts.json) {
    console.log(JSON.stringify({ reports }, null, 2));
    return reports.every((r) => r.ready) ? 0 : 1;
  }

  for (const report of reports) {
    console.log(`
${report.ready ? "✅" : "⚠️"} ${report.ref}`);
    console.log(
      `   ${report.steps} step(s), ${report.playwrightActions} action(s) Playwright, ${report.wrappedActions} enrichie(s), ${report.describedActions} description(s)`
    );
    if (report.actionsOutsideSteps) {
      console.log(`   ${report.actionsOutsideSteps} action(s) hors step`);
    }
    for (const suggestion of report.suggestions) {
      console.log(`   • ${suggestion}`);
    }
  }

  const notReady = reports.filter((r) => !r.ready).length;
  console.log(
    `\n${notReady ? "⚠️" : "✅"} Prepare : ${reports.length - notReady}/${reports.length} testcase(s) structurés pour Cerberus.`
  );
  return notReady ? 1 : 0;
}
