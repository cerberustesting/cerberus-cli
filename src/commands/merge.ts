import fs from "fs";
import path from "path";
import { loadConfig, testsDir } from "../config.js";
import { findLocalTestDirs, readLocalTest, writeLocalTest } from "../dsl/local-format.js";
import { Conflict, mergeTests, Policy } from "../merge.js";
import { fetchServerTest, readState, sameContent, selectTestDirs, testRef, writeState } from "../sync.js";

export interface MergeOptions {
    ours?: boolean;
    theirs?: boolean;
    dryRun?: boolean;
    applyDeletions?: boolean;
}

function short(v: unknown): string {
    if (v === undefined) return "(supprimé)";
    const s = typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v) ?? String(v);
    return s.length > 90 ? s.slice(0, 87) + "..." : s;
}

function printConflict(c: Conflict): void {
    console.log(`   ⚡ ${c.path}`);
    console.log(`        base   : ${short(c.base)}`);
    console.log(`        local  : ${short(c.local)}`);
    console.log(`        serveur: ${short(c.remote)}`);
}

/** Copie les fichiers locaux avant fusion pour pouvoir revenir en arrière. */
function backupLocal(testDir: string): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = path.join(testDir, ".cerberus", "backups", `${stamp}-local`);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of ["cerberus.yaml", "test.spec.ts"]) fs.copyFileSync(path.join(testDir, f), path.join(dir, f));
    return dir;
}

/**
 * Fusionne l'état actuel du serveur dans vos fichiers locaux (fusion à trois voies avec la base du
 * dernier pull). Code de sortie : 0 fusion faite, 1 conflits non résolus (rien n'est écrit).
 */
export async function mergeCommand(refs: string[], opts: MergeOptions): Promise<number> {
    if (opts.ours && opts.theirs) throw new Error("--ours et --theirs sont exclusifs.");
    const policy: Policy = opts.ours ? "ours" : opts.theirs ? "theirs" : "abort";

    const config = loadConfig();
    const dirs = selectTestDirs(findLocalTestDirs(testsDir(config)), refs);
    if (dirs.length === 0) throw new Error("Aucun testcase local. Lancez 'pull' d'abord.");

    let merged = 0;
    let unresolved = 0;
    let untouched = 0;

    for (const testDir of dirs) {
        const state = readState(testDir);
        const label = testDir.split(path.sep).slice(-2).join("/");
        if (!state) {
            console.warn(`⚠️ ${label} : pas d'état de base (.cerberus/state.json), lancez 'pull'.`);
            continue;
        }
        const base = state.serverPayload;
        const server = await fetchServerTest(config, base);
        if (!server) {
            console.warn(`⚠️ ${testRef(base)} : introuvable sur le serveur.`);
            continue;
        }
        if (sameContent(server, base)) {
            untouched++;
            if (refs.length > 0) console.log(`✅ ${testRef(base)} : le serveur n'a pas changé depuis votre dernier pull, rien à fusionner.`);
            continue;
        }

        const { data: local, issues } = readLocalTest(testDir);
        if (issues.length > 0) {
            console.error(`❌ ${testRef(base)} non fusionné : DSL local invalide (lancez 'validate').`);
            unresolved++;
            continue;
        }

        const result = mergeTests(base, local, server, policy, !!opts.applyDeletions);
        console.log(`\n🔀 ${testRef(base)} : base v${base.version}, serveur v${server.version}`);
        result.notes.forEach((n) => console.log(`   • ${n}`));
        if (result.conflicts.length > 0) {
            console.log(`   ${result.conflicts.length} conflit(s)${policy === "abort" ? "" : ` résolu(s) avec ${policy === "ours" ? "votre version locale" : "la version du serveur"}`} :`);
            result.conflicts.forEach(printConflict);
        }

        if (result.conflicts.length > 0 && policy === "abort") {
            console.log(`   ❗ Rien n'a été écrit. Relancez avec --ours (garder le local) ou --theirs (garder le serveur) pour les trancher.`);
            unresolved++;
            continue;
        }
        if (opts.dryRun) {
            console.log("   (simulation : rien n'a été écrit)");
            continue;
        }

        const backup = backupLocal(testDir);
        writeLocalTest(testDir, result.merged);
        // la base devient l'état actuel du serveur : les écarts restants sont vos modifications à pousser
        writeState(testDir, server);
        const dotDir = path.join(testDir, ".cerberus");
        for (const f of fs.readdirSync(dotDir)) if (/^conflict-v.*\.json$/.test(f)) fs.rmSync(path.join(dotDir, f));
        console.log(`   ✅ Fusionné. Sauvegarde de vos fichiers : ${path.relative(process.cwd(), backup)}`);
        merged++;
    }

    console.log(
        `\n${unresolved ? "❗" : "✅"} Merge terminé : ${merged} fusionné(s), ${unresolved} avec conflits, ${untouched} inchangé(s) côté serveur.` +
            (merged ? "\n   Vérifiez avec 'validate', puis 'push --dry-run' avant de pousser." : "")
    );
    return unresolved ? 1 : 0;
}
