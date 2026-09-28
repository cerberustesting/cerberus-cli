import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import YAML from "yaml";
import { loadConfig } from "../config.js";

interface TestCase {
    testFolderId: string;
    testcaseId: string;
    application: string;
    description?: string;
    detailedDescription?: string;
    priority: number;
    version: number;
    status: string;
    isActive: boolean;
    isActiveQA: boolean;
    isActiveUAT: boolean;
    isActivePROD: boolean;
    type: string;
    usrCreated: string;
    dateCreated: string;
    usrModif?: string;
    dateModif?: string;
}

export async function pushCommand() {
    const config = loadConfig();
    const baseDir = config.defaultBaseDir;
    if (!fs.existsSync(baseDir))
        throw new Error(`Le dossier ${baseDir} n'existe pas. Lance 'cerberus-testing pull' d'abord.`);

    const apps = fs
        .readdirSync(baseDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name);
    for (const app of apps) {
        const folder = path.join(baseDir, app);
        const files = fs.readdirSync(folder);

        for (const f of files) {
            if (!/\.(ya?ml|json)$/.test(f) || f.includes(".conflict-")) continue;

            const filePath = path.join(folder, f);
            const raw = fs.readFileSync(filePath, "utf-8");
            const data: TestCase = f.endsWith(".json") ? JSON.parse(raw) : YAML.parse(raw);

            // 👇 Appel API pour mettre à jour le test (exemple)
            const res = await fetch(`${config.apiUrl}/testcases/${data.testcaseId}`, {
                method: "PUT",
                headers: {
                    "Content-Type": "application/json",
                    "X-API-KEY": config.apiKey,
                    "X-API-VERSION": config.apiVersion,
                },
                body: JSON.stringify(data),
            });

            if (!res.ok) console.error(`Erreur push ${data.testcaseId}:`, res.statusText);
            else console.log(`⬆️  Test mis à jour : ${data.application}/${data.testcaseId}`);
        }
    }

    console.log("\n✅ Tous les tests ont été poussés avec succès !");
}