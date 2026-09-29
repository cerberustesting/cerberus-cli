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
        defaultBaseDir: project.defaultBaseDir ?? "./tests",
        application: project.application,
        country: project.country,
        environment: project.environment,
        robot: project.robot,
        oauthClientId: project.oauthClientId,
        authHeaders: () => authHeaders({ projectApiKey: project.apiKey }),
    };
}
