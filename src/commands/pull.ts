import fs from "fs";
import path from "path";
import YAML from "yaml";
import { execSync } from "child_process";
import { loadConfig } from "../config.js";
import { isLocallyModified } from "../sync.js";
import { writeDslTypes } from "../dsl/dsl-types.js";
import {
  generateSpec,
  LocalState,
  toLocalMetadata,
  writeLocalTest,
} from "../dsl/local-format.js";
import {
  CerberusTestCaseByApplicationResponse,
  CerberusTestCaseResponse,
  TestCaseDetailed,
} from "../types.js";

function initLocalGitRepo(baseDir: string): void {
  try {
    if (!fs.existsSync(path.join(baseDir, ".git"))) {
      try {
        execSync("git rev-parse --is-inside-work-tree", { cwd: baseDir, stdio: "ignore" });
        return;
      } catch {
        execSync("git init", { cwd: baseDir, stdio: "ignore" });
      }
    }

    execSync("git add .", { cwd: baseDir, stdio: "ignore" });
    try {
      execSync('git commit -m "🧩 Sync Cerberus baseline" --allow-empty', {
        cwd: baseDir,
        stdio: "ignore",
      });
    } catch {
      // No-op when git identity is missing or there is nothing to commit.
    }
  } catch (err) {
    console.warn("⚠️ Impossible d'initialiser la baseline Git :", (err as Error).message);
  }
}

export async function pullTests(): Promise<void> {
  const config = loadConfig();
  if (!config.application) throw new Error("application manquant dans cerberus.config.json");

  const outputDir = path.resolve(config.defaultBaseDir);
  fs.mkdirSync(outputDir, { recursive: true });
  writeDslTypes(outputDir);

  console.log(`🔄 Récupération des tests depuis ${config.apiUrl}...`);

  const listRes = await fetch(`${config.apiUrl}/testcases/application/${config.application}`, {
    headers: {
      accept: "application/json",
      ...(await config.authHeaders()),
      "X-API-VERSION": config.apiVersion,
    },
  });

  if (!listRes.ok) {
    throw new Error(`Erreur HTTP ${listRes.status}: ${listRes.statusText}`);
  }

  const json = (await listRes.json()) as CerberusTestCaseByApplicationResponse;
  if (!Array.isArray(json.data)) throw new Error("Format API inattendu pour la liste des testcases.");

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let conflicted = 0;

  for (const test of json.data) {
    const testDir = path.join(outputDir, test.testFolderId, test.testcaseId);
    const detailRes = await fetch(
      `${config.apiUrl}/testcases/${encodeURIComponent(test.testFolderId)}/${encodeURIComponent(test.testcaseId)}`,
      {
        headers: {
          accept: "application/json",
          ...(await config.authHeaders()),
          "X-API-VERSION": config.apiVersion,
        },
      }
    );

    if (!detailRes.ok) {
      console.warn(`⚠️ Impossible de récupérer ${test.testFolderId}/${test.testcaseId}`);
      continue;
    }

    const detailJson = (await detailRes.json()) as CerberusTestCaseResponse;
    const server = detailJson.data as TestCaseDetailed;
    const statePath = path.join(testDir, ".cerberus", "state.json");
    const existed = fs.existsSync(statePath);

    if (existed && isLocallyModified(testDir)) {
      const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as LocalState;
      if (String(state.serverPayload.version) === String(server.version)) {
        console.log(`⚠️ Ignoré (modifié localement) → ${test.testFolderId}/${test.testcaseId}`);
        skipped++;
        continue;
      }

      const conflictFile = path.join(
        testDir,
        ".cerberus",
        `conflict-v${server.version}.json`
      );
      fs.mkdirSync(path.dirname(conflictFile), { recursive: true });
      fs.writeFileSync(conflictFile, JSON.stringify(server, null, 2) + "\n", "utf8");
      console.warn(`⚠️ Conflit serveur/local → ${conflictFile}\n   Fusionnez avec : merge ${test.testFolderId}/${test.testcaseId}`);
      conflicted++;
      continue;
    }

    writeLocalTest(testDir, server);
    existed ? updated++ : created++;
  }

  initLocalGitRepo(outputDir);

  console.log(`
✅ Pull terminé :
  - 🆕 Créés : ${created}
  - 🔄 Mis à jour : ${updated}
  - ⚠️ Ignorés (modifiés localement) : ${skipped}
  - ❗ Conflits : ${conflicted}
`);
}
