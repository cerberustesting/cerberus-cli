import fs from "fs";
import path from "path";
import { authHeaders } from "./auth.js";

export { credentialsPath } from "./auth.js";

export interface CerberusConfig {
    apiUrl: string;
    apiVersion: string;
    defaultBaseDir: string;
    application?: string;
    country?: string;
    environment?: string;
    robot?: string;
    /** Client Keycloak à utiliser pour `login` OAuth (sinon celui annoncé par le serveur). */
    oauthClientId?: string;
    /**
     * En-têtes d'authentification (X-API-KEY ou Bearer), résolus à l'appel : une commande qui
     * n'appelle pas l'API (validate) n'exige pas d'identifiants, et un jeton OAuth est rafraîchi si besoin.
     */
    authHeaders(): Promise<Record<string, string>>;
}

const CONFIG_FILE = "cerberus.config.json";

function readJson(file: string): Record<string, any> | null {
    try {
        return JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {
        return null;
    }
}

/** Charge la config du projet (./cerberus.config.json dans le cwd). */
export function loadConfig(): CerberusConfig {
    const file = path.resolve(CONFIG_FILE);
    const project = readJson(file);
    if (!project) {
        throw new Error(`${CONFIG_FILE} introuvable ou invalide dans ${process.cwd()}`);
    }
    if (!project.apiUrl) throw new Error(`apiUrl manquant dans ${CONFIG_FILE}`);

    return {
        apiUrl: project.apiUrl,
        apiVersion: project.apiVersion ?? "1",
        defaultBaseDir: project.defaultBaseDir ?? "./cerberus",
        application: project.application,
        country: project.country,
        environment: project.environment,
        robot: project.robot,
        oauthClientId: project.oauthClientId,
        authHeaders: () => authHeaders({ projectApiKey: project.apiKey }),
    };
}


export interface CerberusWorkspacePaths {
    root: string;
    tests: string;
    applicationObjects: string;
    services: string;
    datalib: string;
    labels: string;
    internal: string;
}

export function workspacePaths(config: Pick<CerberusConfig, "defaultBaseDir">): CerberusWorkspacePaths {
    const root = path.resolve(config.defaultBaseDir);
    return {
        root,
        tests: path.join(root, "tests"),
        applicationObjects: path.join(root, "applicationObjects"),
        services: path.join(root, "services"),
        datalib: path.join(root, "datalib"),
        labels: path.join(root, "labels"),
        internal: path.join(root, ".cerberus"),
    };
}

/** Racine du workspace Cerberus local. */
export function workspaceDir(config: Pick<CerberusConfig, "defaultBaseDir">): string {
    return workspacePaths(config).root;
}

function looksLikeLegacyTestsRoot(baseDir: string): boolean {
    if (!fs.existsSync(baseDir)) return false;
    try {
        for (const folder of fs.readdirSync(baseDir, { withFileTypes: true })) {
            if (!folder.isDirectory() || folder.name.startsWith(".")) continue;
            const folderPath = path.join(baseDir, folder.name);
            for (const testcase of fs.readdirSync(folderPath, { withFileTypes: true })) {
                if (!testcase.isDirectory() || testcase.name.startsWith(".")) continue;
                if (fs.existsSync(path.join(folderPath, testcase.name, "cerberus.yaml"))) return true;
            }
        }
    } catch {
        return false;
    }
    return false;
}

/**
 * Répertoire des testcases dans le workspace.
 * Compatibilité : un ancien workspace sans /tests mais contenant directement les test folders
 * continue d'être reconnu tant qu'il n'a pas migré.
 */
export function testsDir(config: Pick<CerberusConfig, "defaultBaseDir">): string {
    const root = workspaceDir(config);
    const nested = workspacePaths(config).tests;
    if (fs.existsSync(nested)) return nested;
    if (looksLikeLegacyTestsRoot(root)) return root;
    return nested;
}
