import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import crypto from "crypto";
import YAML from "yaml";
import { execSync } from "child_process";
import { loadConfig } from "../config.js";

// Import des vrais types Cerberus
import {
    TestCase,
    TestCaseDetailed,
    CerberusTestCaseByApplicationResponse,
    CerberusTestCaseResponse,
} from "../types.js";

/** Hash simple pour comparer le contenu d’un test */
function hashContent(content: string): string {
    return crypto.createHash("sha256").update(content).digest("hex");
}

/** Lecture d’un fichier YAML ou JSON */
function readTestFile<T>(filePath: string): T | null {
    try {
        const content = fs.readFileSync(filePath, "utf8");
        if (filePath.endsWith(".yaml") || filePath.endsWith(".yml")) {
            return YAML.parse(content);
        } else {
            return JSON.parse(content);
        }
    } catch {
        return null;
    }
}

/** Écriture d’un fichier YAML */
function writeTestFile<T>(filePath: string, data: T) {
    const yaml = YAML.stringify(data);
    fs.writeFileSync(filePath, yaml, "utf8");
}

function initLocalGitRepo(baseDir: string) {
    try {
        // Dans un dépôt git existant, on laisse le dépôt hôte suivre les changements
        if (!fs.existsSync(path.join(baseDir, ".git"))) {
            try {
                execSync("git rev-parse --is-inside-work-tree", { cwd: baseDir, stdio: "ignore" });
                console.log("ℹ️  Dossier déjà suivi par le dépôt git du projet, pas de dépôt imbriqué.");
                return;
            } catch {
                // hors dépôt git : on continue
            }

            console.log("🌀 Initialisation du dépôt local pour suivi des modifications...");
            execSync("git init", { cwd: baseDir, stdio: ["ignore", "ignore", "pipe"] });
        }

        // On ajoute tout et commit pour créer ou mettre à jour la baseline
        execSync("git add .", { cwd: baseDir, stdio: ["ignore", "ignore", "pipe"] });

        try {
            execSync('git commit -m "🧩 Sync Cerberus baseline" --allow-empty', {
                cwd: baseDir,
                stdio: "ignore",
            });
        } catch {
            // Ignore si rien à commit
        }

        // On ajoute un .gitignore (optionnel mais propre)
        const gitignorePath = path.join(baseDir, ".gitignore");
        if (!fs.existsSync(gitignorePath)) {
            fs.writeFileSync(gitignorePath, ".git/\n", "utf8");
        }

        console.log("✅ Baseline Git initialisée pour suivi des modifications locales.\n");
    } catch (err) {
        const stderr = (err as { stderr?: Buffer }).stderr?.toString().trim();
        console.warn(
            "⚠️ Impossible d’initialiser le dépôt Git local :",
            stderr || (err as Error).message
        );
    }
}

/** Pull complet des tests depuis Cerberus */
export async function pullTests() {
    const config = loadConfig();
    if (!config.application) {
        console.error("❌ application manquant dans cerberus.config.json !");
        process.exit(1);
    }
    const outputDir = path.resolve(config.defaultBaseDir);
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    console.log(`🔄 Récupération des tests depuis ${config.apiUrl}...`);

    const listRes = await fetch(`${config.apiUrl}/testcases/application/${config.application}`, {
        headers: {
            accept: "application/json",
            "X-API-KEY": config.apiKey,
            "X-API-VERSION": config.apiVersion,
        },
    });

    if (!listRes.ok) {
        console.error("❌ Erreur HTTP:", listRes.status, listRes.statusText);
        return;
    }

    const json = (await listRes.json()) as CerberusTestCaseByApplicationResponse;

    if (!json.data || !Array.isArray(json.data)) {
        console.error("❌ Format inattendu:", json);
        return;
    }

    let updated = 0,
        skipped = 0,
        conflicted = 0,
        created = 0;

    // Boucle sur tous les tests
    for (const test of json.data) {
        const folderPath = path.join(outputDir, test.testFolderId);
        if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath, { recursive: true });

        const filePath = path.join(folderPath, `${test.testcaseId}.yaml`);

        // Appel du détail du test
        const detailRes = await fetch(
            `${config.apiUrl}/testcases/${test.testFolderId}/${test.testcaseId}`,
            {
                headers: {
                    accept: "application/json",
                    "X-API-KEY": config.apiKey,
                    "X-API-VERSION": config.apiVersion,
                },
            }
        );

        if (!detailRes.ok) {
            console.warn(`⚠️  Impossible de récupérer le détail du test ${test.testcaseId}`);
            continue;
        }

        const detailJson = (await detailRes.json()) as CerberusTestCaseResponse;
        const detailedData = detailJson.data as TestCaseDetailed;

        // Vérification de version et hash local
        if (fs.existsSync(filePath)) {
            const localRaw = fs.readFileSync(filePath, "utf8");
            const localData = readTestFile<TestCaseDetailed>(filePath);
            if (!localData) continue;

            const localHash = hashContent(localRaw);
            const serverHash = hashContent(YAML.stringify(detailedData));

            if (localData.version === detailedData.version) {
                if (localHash !== serverHash) {
                    console.log(`⚠️  Ignoré (modifié localement, même version) → ${filePath}`);
                    skipped++;
                    continue;
                }
                // même hash = inchangé → mise à jour silencieuse
                writeTestFile(filePath, detailedData);
                updated++;
                continue;
            }

            // Version différente → conflit
            if (localHash !== serverHash) {
                const conflictFile = filePath.replace(
                    ".yaml",
                    `.conflict-v${detailedData.version}.yaml`
                );
                writeTestFile(conflictFile, detailedData);
                console.warn(`⚠️  Conflit détecté → ${conflictFile}`);
                conflicted++;
                continue;
            }
        }

        // Nouveau fichier
        writeTestFile(filePath, detailedData);
        created++;
    }

    // 🔚 Initialisation ou mise à jour du dépôt Git local pour suivi visuel dans l’IDE
    console.log(`init Repo Git`);
    initLocalGitRepo(outputDir);

    console.log(`\n✅ Pull terminé :
    - 🆕 Créés : ${created}
    - 🔄 Mis à jour : ${updated}
    - ⚠️ Ignorés (modifiés localement) : ${skipped}
    - ❗ Conflits : ${conflicted}
  `);
}

/** JSON stable pour hashing */
function stableStringify(obj: any): string {
    return JSON.stringify(sortKeys(obj), null, 2);
}

/** Tri récursif des clés d’un objet */
function sortKeys(obj: any): any {
    if (Array.isArray(obj)) return obj.map(sortKeys);
    if (obj && typeof obj === "object") {
        return Object.keys(obj)
            .sort()
            .reduce((acc: any, key) => {
                acc[key] = sortKeys(obj[key]);
                return acc;
            }, {});
    }
    return obj;
}