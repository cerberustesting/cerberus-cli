import fs from "fs";
import os from "os";
import path from "path";

export interface CerberusConfig {
    apiUrl: string;
    apiKey: string;
    apiVersion: string;
    defaultBaseDir: string;
    application?: string;
    country?: string;
    environment?: string;
    robot?: string;
}

const CONFIG_FILE = "cerberus.config.json";

/** Fichier de credentials utilisateur, hors du dépôt du projet. */
export function credentialsPath(): string {
    const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
    return path.join(base, "cerberus", "credentials.json");
}

function readJson(file: string): Record<string, any> | null {
    try {
        return JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {
        return null;
    }
}

/**
 * Charge la config du projet (./cerberus.config.json dans le cwd).
 * La clé API est résolue dans cet ordre :
 *  1. variable d'environnement CERBERUS_API_KEY
 *  2. ~/.config/cerberus/credentials.json (écrit par `login`)
 *  3. champ apiKey du fichier de projet (déprécié : risque de fuite via git)
 */
export function loadConfig(): CerberusConfig {
    const file = path.resolve(CONFIG_FILE);
    const project = readJson(file);
    if (!project) {
        throw new Error(`${CONFIG_FILE} introuvable ou invalide dans ${process.cwd()}`);
    }

    let apiKey = process.env.CERBERUS_API_KEY || readJson(credentialsPath())?.apiKey;
    if (!apiKey && project.apiKey) {
        console.warn(
            `⚠️  apiKey lue dans ${CONFIG_FILE} : ne la commitez pas. Utilisez 'login' ou CERBERUS_API_KEY.`
        );
        apiKey = project.apiKey;
    }
    if (!apiKey) {
        throw new Error("Clé API manquante. Lancez 'login' ou définissez CERBERUS_API_KEY.");
    }
    if (!project.apiUrl) throw new Error(`apiUrl manquant dans ${CONFIG_FILE}`);

    return {
        apiUrl: project.apiUrl,
        apiKey,
        apiVersion: project.apiVersion ?? "1",
        defaultBaseDir: project.defaultBaseDir ?? "./tests",
        application: project.application,
        country: project.country,
        environment: project.environment,
        robot: project.robot,
    };
}

/** Enregistre la clé API dans le fichier de credentials utilisateur (mode 600). */
export function saveApiKey(apiKey: string): string {
    const file = credentialsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ apiKey }, null, 2), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return file;
}
