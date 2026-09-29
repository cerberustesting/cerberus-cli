import readline from "readline";
import {
    cerberusBaseUrl,
    clearCredentials,
    credentialsPath,
    discoverOAuth,
    oauthLogin,
    readCredentials,
    saveCredentials,
} from "../auth.js";
import { loadConfig } from "../config.js";

function promptHidden(question: string): Promise<string> {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        const out = rl as unknown as { _writeToOutput: (s: string) => void };
        process.stdout.write(question);
        out._writeToOutput = () => {};
        rl.question("", (answer) => {
            rl.close();
            process.stdout.write("\n");
            resolve(answer.trim());
        });
    });
}

export interface LoginOptions {
    apiKey?: string | true;
    oauth?: boolean;
    port?: string;
    clientId?: string;
}

async function saveApiKey(value: string | true): Promise<void> {
    const apiKey = value === true ? await promptHidden("Clé API Cerberus : ") : value;
    if (!apiKey) throw new Error("Clé API vide.");
    const file = saveCredentials({ mode: "apikey", apiKey });
    console.log(`✅ Clé API enregistrée dans ${file} (mode 600)`);
}

/**
 * `login` sans option : OAuth si le serveur l'active, sinon saisie d'une clé API.
 * `--api-key [clé]` force la clé API, `--oauth` force OAuth.
 */
export async function loginCommand(opts: LoginOptions): Promise<void> {
    if (opts.apiKey !== undefined && opts.oauth) throw new Error("--api-key et --oauth sont exclusifs.");
    if (opts.apiKey !== undefined) return saveApiKey(opts.apiKey);

    const config = loadConfig();
    const cerberusUrl = cerberusBaseUrl(config.apiUrl);
    const discovery = await discoverOAuth(cerberusUrl, opts.clientId ?? config.oauthClientId);

    if (!discovery) {
        if (opts.oauth) throw new Error(`OAuth n'est pas activé sur ${cerberusUrl}. Utilisez une clé API.`);
        console.log(`ℹ️  OAuth non disponible sur ${cerberusUrl} : connexion par clé API.`);
        return saveApiKey(true);
    }

    console.log(`🔐 Connexion à ${cerberusUrl} via Keycloak (realm ${discovery.realm}, client ${discovery.clientId})...`);
    const session = await oauthLogin(cerberusUrl, discovery, {
        port: opts.port ? Number(opts.port) : undefined,
        onUrl: (url) => console.log(`   Si le navigateur ne s'ouvre pas, ouvrez :\n   ${url}\n`),
    });
    const file = saveCredentials({ mode: "oauth", oauth: session });
    console.log(`✅ Connecté${session.login ? ` en tant que ${session.login}` : ""}. Session enregistrée dans ${file} (mode 600)`);
}

export function logoutCommand(): void {
    console.log(clearCredentials() ? "✅ Identifiants supprimés." : "ℹ️  Aucun identifiant enregistré.");
    if (process.env.CERBERUS_API_KEY) console.log("ℹ️  CERBERUS_API_KEY est toujours définie dans votre environnement.");
}

export function whoamiCommand(): void {
    if (process.env.CERBERUS_API_KEY) {
        console.log("Authentifié par la variable d'environnement CERBERUS_API_KEY (clé API).");
        return;
    }
    const stored = readCredentials();
    if (!stored) {
        console.log(`Non authentifié (${credentialsPath()} absent). Lancez 'login'.`);
        process.exitCode = 1;
    } else if (stored.mode === "apikey") {
        console.log("Authentifié par clé API enregistrée.");
    } else {
        const left = Math.round(stored.oauth.expiresAt - Date.now() / 1000);
        console.log(
            `Authentifié par OAuth${stored.oauth.login ? ` en tant que ${stored.oauth.login}` : ""} sur ${stored.oauth.cerberusUrl}` +
                ` (jeton ${left > 0 ? `valide encore ${left}s` : "expiré, rafraîchi au prochain appel"}).`
        );
    }
}
