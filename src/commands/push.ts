import fs from "fs";
import fetch from "node-fetch";
import { loadConfig } from "../config.js";
import { findLocalTestDirs, readLocalTest } from "../dsl/local-format.js";

export async function pushCommand(): Promise<void> {
  const config = loadConfig();
  const baseDir = config.defaultBaseDir;

  if (!fs.existsSync(baseDir)) {
    throw new Error(`Le dossier ${baseDir} n'existe pas. Lance 'cerberus pull' d'abord.`);
  }

  const testDirs = findLocalTestDirs(baseDir);
  if (testDirs.length === 0) {
    throw new Error("Aucun testcase au nouveau format local. Lance 'cerberus pull' d'abord.");
  }

  let pushed = 0;

  for (const testDir of testDirs) {
    const { data, issues } = readLocalTest(testDir);

    if (issues.length > 0) {
      console.error(`❌ ${data.testFolderId}/${data.testcaseId} non poussé : DSL invalide`);
      for (const issue of issues) {
        console.error(`   ${issue.file}${issue.line ? `:${issue.line}` : ""} - ${issue.message}`);
      }
      continue;
    }

    const res = await fetch(`${config.apiUrl}/testcases/${data.testcaseId}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": config.apiKey,
        "X-API-VERSION": config.apiVersion,
      },
      body: JSON.stringify(data),
    });

    if (!res.ok) {
      console.error(
        `❌ Erreur push ${data.testFolderId}/${data.testcaseId}: ${res.status} ${res.statusText}`
      );
      continue;
    }

    console.log(`⬆️ Test mis à jour : ${data.testFolderId}/${data.testcaseId}`);
    pushed++;
  }

  console.log(`\n✅ Push terminé : ${pushed}/${testDirs.length} test(s) envoyé(s).`);
}
