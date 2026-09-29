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
  actions: number;
  controls: number;
  properties: number;
  ready: boolean;
  suggestions: string[];
}

function analyzeTestcase(testDir: string): PrepareReport {
  const file = path.join(testDir, "testcase.ts");
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  let steps = 0;
  let actions = 0;
  let controls = 0;
  let properties = 0;
  let hasTestcase = false;

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "cerberus" &&
        node.expression.name.text === "testcase"
      ) {
        hasTestcase = true;
      }

      if (ts.isIdentifier(node.expression) && node.expression.text === "step") steps++;

      if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "step" &&
        node.expression.name.text === "library"
      ) steps++;

      if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)) {
        if (node.expression.expression.text === "action") actions++;
        if (node.expression.expression.text === "control") controls++;
        if (node.expression.expression.text === "property" && node.expression.name.text === "define") {
          const arg = node.arguments[0];
          if (arg && ts.isObjectLiteralExpression(arg)) properties += arg.properties.length;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  const suggestions: string[] = [];
  if (!hasTestcase) suggestions.push("Ajouter cerberus.testcase({...}) comme racine du fichier.");
  if (steps === 0) suggestions.push("Ajouter au moins un step(...) ou step.library(...).");
  if (actions === 0) suggestions.push("Le testcase ne contient aucune action.");

  return {
    ref: testDir.split(path.sep).slice(-2).join("/"),
    file,
    steps,
    actions,
    controls,
    properties,
    ready: hasTestcase && steps > 0,
    suggestions,
  };
}

export async function prepareCommand(refs: string[], opts: PrepareOptions): Promise<number> {
  const config = loadConfig();
  const allDirs = findLocalTestDirs(testsDir(config));
  if (allDirs.length === 0) {
    throw new Error("Aucun testcase local trouvé. Lancez 'pull' ou créez un testcase.ts.");
  }

  const dirs = selectTestDirs(allDirs, refs);
  const reports = dirs.map(analyzeTestcase);

  if (opts.json) {
    console.log(JSON.stringify({ reports }, null, 2));
    return reports.every((r) => r.ready) ? 0 : 1;
  }

  for (const report of reports) {
    console.log(`\n${report.ready ? "✅" : "⚠️"} ${report.ref}`);
    console.log(
      `   ${report.steps} step(s), ${report.actions} action(s), ${report.controls} contrôle(s), ${report.properties} propriété(s)`
    );
    report.suggestions.forEach((suggestion) => console.log(`   • ${suggestion}`));
  }

  const notReady = reports.filter((r) => !r.ready).length;
  console.log(
    `\n${notReady ? "⚠️" : "✅"} Prepare : ${reports.length - notReady}/${reports.length} testcase(s) structurés.`
  );
  return notReady ? 1 : 0;
}
