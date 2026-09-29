import fs from "fs";
import path from "path";
import { loadConfig } from "../config.js";
import { findLocalTestDirs, readLocalTest, writeLocalTest } from "../dsl/local-format.js";
import {
  backupServerState,
  createServerTest,
  describeChanges,
  describeHttpFailure,
  fetchServerTest,
  isLocallyModified,
  putServerTest,
  readState,
  sameContent,
  selectTestDirs,
  testRef,
  verifyPush,
} from "../sync.js";

export interface PushOptions {
  /** pousse aussi les tests sans modification locale */
  all?: boolean;
  /** pousse même si le serveur a changé depuis le dernier pull (écrase ces changements) */
  force?: boolean;
  /** montre ce qui serait envoyé sans rien modifier */
  dryRun?: boolean;
}

/**
 * Garde-fous, dans l'ordre, pour chaque test :
 *  1. seuls les tests modifiés localement sont poussés (sauf --all)
 *  2. le DSL doit être valide
 *  3. le serveur ne doit pas avoir changé depuis le dernier pull (sinon 'merge' ou --force)
 *  4. l'état du serveur est sauvegardé avant l'envoi
 *  5. après l'envoi, le testcase est relu et comparé (pays, propriétés, étapes) ; tout écart est une erreur
 * Code de sortie : 0 tout va bien, 1 au moins un test bloqué ou en écart.
 */
export async function pushCommand(refs: string[], opts: PushOptions): Promise<number> {
  const config = loadConfig();
  const baseDir = config.defaultBaseDir;

  if (!fs.existsSync(baseDir)) {
    throw new Error(`Le dossier ${baseDir} n'existe pas. Lancez 'pull' d'abord.`);
  }
  const allDirs = findLocalTestDirs(baseDir);
  if (allDirs.length === 0) throw new Error("Aucun testcase au format local. Lancez 'pull' d'abord.");

  const dirs = selectTestDirs(allDirs, refs);
  const explicit = refs.length > 0;

  let pushed = 0;
  let unchanged = 0;
  let blocked = 0;
  let failed = 0;

  for (const testDir of dirs) {
    const label = testDir.split(path.sep).slice(-2).join("/");

    // 1. modifié localement ?
    if (!opts.all && !explicit && !isLocallyModified(testDir)) {
      unchanged++;
      continue;
    }
    if (!opts.all && explicit && !isLocallyModified(testDir)) {
      console.log(`⏭️  ${label} : aucune modification locale (utilisez --all pour forcer l'envoi).`);
      unchanged++;
      continue;
    }

    // 2. DSL valide ?
    const { data, issues } = readLocalTest(testDir);
    if (issues.length > 0) {
      console.error(`❌ ${label} non poussé : DSL invalide`);
      for (const issue of issues) {
        console.error(`   ${issue.file}${issue.line ? `:${issue.line}` : ""} - ${issue.message}`);
      }
      failed++;
      continue;
    }

    const state = readState(testDir);

    // 3. le serveur existe-t-il / a-t-il changé ?
    let server;
    try {
      server = await fetchServerTest(config, data);
    } catch (err) {
      console.error(`❌ ${label} : ${(err as Error).message}`);
      failed++;
      continue;
    }
    if (!server) {
      if (opts.dryRun) {
        console.log(`🆕 ${label} : serait créé sur le serveur`);
        console.log(`   • application : ${data.application}`);
        console.log(`   • description : ${data.description}`);
        console.log(`   • steps : ${data.steps?.length ?? 0}`);
        continue;
      }

      const createRes = await createServerTest(config, data);
      if (!createRes.ok) {
        console.error(`❌ Création ${label} impossible : ${await describeHttpFailure(createRes)}`);
        failed++;
        continue;
      }

      let created;
      try {
        const body = (await createRes.json()) as { data?: typeof data };
        created = body.data;
      } catch {
        created = undefined;
      }

      const createdRef = created
        ? { testFolderId: created.testFolderId, testcaseId: created.testcaseId }
        : { testFolderId: data.testFolderId, testcaseId: data.testcaseId };

      let afterCreate;
      try {
        afterCreate = created ?? (await fetchServerTest(config, createdRef));
      } catch (err) {
        console.error(`❌ ${label} : créé, mais impossible de relire le testcase : ${(err as Error).message}`);
        failed++;
        continue;
      }

      if (!afterCreate) {
        console.error(`❌ ${label} : création annoncée mais testcase introuvable après POST.`);
        failed++;
        continue;
      }

      const problems = verifyPush(data, afterCreate).filter(
        (problem) => !problem.startsWith("testcaseId")
      );
      if (problems.length > 0) {
        console.error(`❌ ${label} : testcase créé mais contenu différent de ce qui était attendu`);
        problems.forEach((problem) => console.error(`   • ${problem}`));
        failed++;
        continue;
      }

      writeLocalTest(testDir, afterCreate);
      console.log(
        `🆕 ${label} : créé sur le serveur comme ${afterCreate.testFolderId}/${afterCreate.testcaseId} (v${afterCreate.version}), vérifié.`
      );
      pushed++;
      continue;
    }

    if (!state) {
      console.error(
        `❌ ${label} non poussé : le testcase existe déjà sur le serveur mais aucun état local de base n'est disponible. Lancez 'pull' avant de l'écraser.`
      );
      blocked++;
      continue;
    }

    if (!sameContent(server, state.serverPayload)) {
      if (!opts.force) {
        console.error(
          `⛔ ${label} non poussé : le serveur a changé depuis votre dernier pull (base v${state.serverPayload.version}, serveur v${server.version}).\n` +
            `   Fusionnez avec 'merge ${label}' (ou 'merge ${label} --dry-run' pour prévisualiser).\n` +
            `   --force écraserait les changements du serveur.`
        );
        blocked++;
        continue;
      }
      console.warn(`⚠️ ${label} : --force, les changements faits sur le serveur depuis v${state.serverPayload.version} seront écrasés.`);
    }

    if (opts.dryRun) {
      const changes = describeChanges(server, data);
      console.log(`🔎 ${label} (serveur v${server.version}) : ${changes.length ? "" : "aucune différence avec le serveur"}`);
      changes.forEach((c) => console.log(`   • ${c}`));
      continue;
    }

    // 4. sauvegarde de l'état du serveur
    const backup = backupServerState(testDir, server);

    // 5. envoi puis relecture
    const res = await putServerTest(config, data, server.version);
    if (!res.ok) {
      console.error(`❌ Erreur push ${label}: ${await describeHttpFailure(res)}`);
      console.error(`   État du serveur avant l'envoi : ${path.relative(process.cwd(), backup)}`);
      failed++;
      continue;
    }

    let after;
    try {
      after = await fetchServerTest(config, data);
    } catch (err) {
      console.error(`❌ ${label} : envoyé, mais la relecture de contrôle a échoué : ${(err as Error).message}`);
      failed++;
      continue;
    }
    const problems = after ? verifyPush(data, after) : ["testcase introuvable après l'envoi"];
    if (problems.length > 0) {
      console.error(`❌ ${label} : le serveur ne contient pas ce qui a été envoyé !`);
      problems.forEach((p) => console.error(`   • ${p}`));
      console.error(
        `   État du serveur avant l'envoi : ${path.relative(process.cwd(), backup)}\n` +
          `   Vos fichiers locaux n'ont pas été modifiés. Corrigez côté serveur ou restaurez depuis la sauvegarde.`
      );
      failed++;
      continue;
    }

    // la base locale devient ce que le serveur contient réellement
    writeLocalTest(testDir, after!);
    console.log(`⬆️ ${label} : mis à jour (v${server.version} → v${after!.version}), vérifié.`);
    pushed++;
  }

  const parts = [`${pushed} poussé(s)`];
  if (unchanged) parts.push(`${unchanged} sans modification locale`);
  if (blocked) parts.push(`${blocked} bloqué(s) (serveur modifié)`);
  if (failed) parts.push(`${failed} en erreur`);
  console.log(`\n${blocked || failed ? "❗" : "✅"} Push terminé : ${parts.join(", ")}.`);
  return blocked || failed ? 1 : 0;
}
