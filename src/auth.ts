import crypto from "crypto";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { spawn } from "child_process";

/**
 * Deux modes d'authentification vers l'API publique Cerberus :
 *  - clé API  : en-tête X-API-KEY
 *  - OAuth    : Authorization Code + PKCE contre Keycloak (comme le Local Runner),
 *               puis en-tête Authorization: Bearer <access_token>
 */

export interface OAuthSession {
    cerberusUrl: string;
    keycloakUrl: string;
    realm: string;
    clientId: string;
    accessToken: string;
    refreshToken: string;
    /** epoch en secondes */
    expiresAt: number;
    login?: string;
}

export type StoredCredentials =
    | { mode: "apikey"; apiKey: string }
    | { mode: "oauth"; oauth: OAuthSession };

const EXPIRY_SKEW_SECONDS = 30;
const DEFAULT_CLIENT_ID = "cerberus-local-runner";
const DEFAULT_PORT = 18080;
const LOGIN_TIMEOUT_MS = 300_000;
const FETCH_TIMEOUT_MS = 10_000;

/** Fichier de credentials utilisateur, hors du dépôt du projet. */
export function credentialsPath(): string {
    const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
    return path.join(base, "cerberus", "credentials.json");
}

export function readCredentials(): StoredCredentials | null {
    try {
        const raw = JSON.parse(fs.readFileSync(credentialsPath(), "utf8"));
        if (raw.mode === "oauth" && raw.oauth) return { mode: "oauth", oauth: raw.oauth };
        // ancien format { apiKey } sans mode
        if (raw.apiKey) return { mode: "apikey", apiKey: raw.apiKey };
    } catch {
        // absent ou illisible
    }
    return null;
}

export function saveCredentials(credentials: StoredCredentials): string {
    const file = credentialsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(credentials, null, 2), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return file;
}

/** Supprime les credentials enregistrés. Renvoie false s'il n'y en avait pas. */
export function clearCredentials(): boolean {
    try {
        fs.unlinkSync(credentialsPath());
        return true;
    } catch {
        return false;
    }
}

/** URL racine de Cerberus à partir de l'URL de l'API publique (…/api/public). */
export function cerberusBaseUrl(apiUrl: string): string {
    return apiUrl.replace(/\/+$/, "").replace(/\/api\/public$/, "");
}

function trimSlashes(url: string): string {
    return url.trim().replace(/\/+$/, "");
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
    return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

function tokenEndpoint(s: { keycloakUrl: string; realm: string }): string {
    return `${s.keycloakUrl}/realms/${encodeURIComponent(s.realm)}/protocol/openid-connect/token`;
}

// ---------------------------------------------------------------- en-têtes d'auth

export interface AuthOptions {
    /** Clé API du fichier de projet (déprécié). */
    projectApiKey?: string;
}

/**
 * En-têtes d'authentification pour un appel API. Ordre de priorité :
 *  1. CERBERUS_API_KEY (CI)
 *  2. credentials enregistrés par `login` (clé API ou session OAuth, rafraîchie si besoin)
 *  3. apiKey du fichier de projet (déprécié : risque de fuite via git)
 */
export async function authHeaders(opts: AuthOptions = {}): Promise<Record<string, string>> {
    if (process.env.CERBERUS_API_KEY) return { "X-API-KEY": process.env.CERBERUS_API_KEY };

    const stored = readCredentials();
    if (stored?.mode === "apikey") return { "X-API-KEY": stored.apiKey };
    if (stored?.mode === "oauth") {
        return { Authorization: `Bearer ${await validAccessToken(stored.oauth)}` };
    }

    if (opts.projectApiKey) {
        console.warn("⚠️  apiKey lue dans cerberus.config.json : ne la commitez pas. Utilisez 'login' ou CERBERUS_API_KEY.");
        return { "X-API-KEY": opts.projectApiKey };
    }
    throw new Error("Non authentifié. Lancez 'login' ou définissez CERBERUS_API_KEY.");
}

async function validAccessToken(session: OAuthSession): Promise<string> {
    if (Date.now() / 1000 < session.expiresAt - EXPIRY_SKEW_SECONDS) return session.accessToken;
    return refresh(session);
}

async function refresh(session: OAuthSession): Promise<string> {
    const expired = new Error("Session OAuth expirée. Relancez 'login'.");
    if (!session.refreshToken) throw expired;

    const res = await fetchWithTimeout(tokenEndpoint(session), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: session.refreshToken,
            client_id: session.clientId,
        }),
    });
    if (res.status !== 200) throw expired;

    const body = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error("Réponse Keycloak sans access_token lors du rafraîchissement.");

    const next: OAuthSession = {
        ...session,
        accessToken: body.access_token,
        refreshToken: body.refresh_token || session.refreshToken,
        expiresAt: Math.floor(Date.now() / 1000) + (body.expires_in || 60),
    };
    saveCredentials({ mode: "oauth", oauth: next });
    return next.accessToken;
}

// ---------------------------------------------------------------- login OAuth

export interface OAuthDiscovery {
    keycloakUrl: string;
    realm: string;
    clientId: string;
}

/** Lit la config OAuth publique du serveur. Renvoie null si OAuth n'est pas activé. */
export async function discoverOAuth(cerberusUrl: string, clientIdOverride?: string): Promise<OAuthDiscovery | null> {
    let res: Response;
    try {
        res = await fetchWithTimeout(`${cerberusUrl}/api/public/oauth-config`, { headers: { Accept: "application/json" } }, 8000);
    } catch (err) {
        throw new Error(`Cerberus injoignable sur ${cerberusUrl} : ${(err as Error).message}`);
    }
    if (res.status !== 200) return null;
    const body = (await res.json()) as {
        enabled?: boolean;
        keycloakUrl?: string;
        realm?: string;
        localRunnerClientId?: string;
    };
    if (!body.enabled || !body.keycloakUrl?.trim() || !body.realm?.trim()) return null;
    return {
        keycloakUrl: trimSlashes(body.keycloakUrl),
        realm: body.realm.trim(),
        clientId: clientIdOverride || body.localRunnerClientId?.trim() || DEFAULT_CLIENT_ID,
    };
}

function randomToken(bytes: number): string {
    return crypto.randomBytes(bytes).toString("base64url");
}

function openBrowser(url: string): void {
    const [cmd, args] =
        process.platform === "darwin" ? ["open", [url]]
        : process.platform === "win32" ? ["cmd", ["/c", "start", "", url.replace(/&/g, "^&")]]
        : ["xdg-open", [url]];
    try {
        spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
    } catch {
        // l'URL est aussi affichée dans le terminal
    }
}

const PAGE = (msg: string) =>
    `<!doctype html><meta charset="utf-8"><title>Cerberus CLI</title><body style="font-family:sans-serif;margin:3em"><h2>${msg}</h2><p>Vous pouvez fermer cet onglet.</p>`;

/** Attend la redirection Keycloak sur http://127.0.0.1:<port>/oauth/callback. */
function waitForCallback(port: number, state: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
            if (url.pathname !== "/oauth/callback") {
                res.writeHead(404).end();
                return;
            }
            const error = url.searchParams.get("error");
            const code = url.searchParams.get("code");
            const fail = (message: string) => {
                res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end(PAGE("❌ " + message));
                finish(new Error(message));
            };
            if (error) return fail(`Keycloak a renvoyé une erreur : ${error} ${url.searchParams.get("error_description") ?? ""}`.trim());
            if (url.searchParams.get("state") !== state) return fail("État OAuth invalide (state).");
            if (!code) return fail("Keycloak n'a pas renvoyé de code d'autorisation.");
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(PAGE("✅ Connecté à Cerberus"));
            finish(null, code);
        });
        const timer = setTimeout(() => finish(new Error("Délai dépassé : aucune connexion dans le navigateur.")), LOGIN_TIMEOUT_MS);
        const finish = (err: Error | null, code?: string) => {
            clearTimeout(timer);
            server.close();
            server.closeAllConnections?.();
            err ? reject(err) : resolve(code!);
        };
        server.on("error", (err: NodeJS.ErrnoException) =>
            finish(
                err.code === "EADDRINUSE"
                    ? new Error(`Le port ${port} est déjà utilisé (Local Runner ouvert ?). Fermez-le ou utilisez --port.`)
                    : err
            )
        );
        server.listen(port, "127.0.0.1");
    });
}

export interface OAuthLoginOptions {
    port?: number;
    clientId?: string;
    onUrl?: (url: string) => void;
}

/** Authorization Code + PKCE (S256), redirection loopback, comme le Local Runner. */
export async function oauthLogin(cerberusUrl: string, discovery: OAuthDiscovery, opts: OAuthLoginOptions = {}): Promise<OAuthSession> {
    const port = opts.port ?? DEFAULT_PORT;
    const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;
    const state = randomToken(24);
    const verifier = randomToken(48);
    const challenge = crypto.createHash("sha256").update(verifier, "ascii").digest("base64url");

    const authorizeUrl =
        `${discovery.keycloakUrl}/realms/${encodeURIComponent(discovery.realm)}/protocol/openid-connect/auth?` +
        new URLSearchParams({
            response_type: "code",
            client_id: discovery.clientId,
            redirect_uri: redirectUri,
            scope: "openid profile email",
            state,
            code_challenge: challenge,
            code_challenge_method: "S256",
        });

    // Le serveur écoute avant l'ouverture du navigateur pour ne pas rater la redirection.
    const codePromise = waitForCallback(port, state);
    codePromise.catch(() => {}); // évite un unhandledRejection si l'ouverture échoue avant
    opts.onUrl?.(authorizeUrl);
    openBrowser(authorizeUrl);
    const code = await codePromise;

    const res = await fetchWithTimeout(tokenEndpoint(discovery), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
            client_id: discovery.clientId,
            code_verifier: verifier,
        }),
    });
    const text = await res.text();
    if (res.status !== 200) throw new Error(`Échange du code refusé : HTTP ${res.status} ${text.slice(0, 300)}`);
    const body = JSON.parse(text) as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error("Réponse Keycloak sans access_token.");

    return {
        cerberusUrl,
        keycloakUrl: discovery.keycloakUrl,
        realm: discovery.realm,
        clientId: discovery.clientId,
        accessToken: body.access_token,
        refreshToken: body.refresh_token ?? "",
        expiresAt: Math.floor(Date.now() / 1000) + (body.expires_in || 60),
        login: await fetchLogin(discovery, body.access_token),
    };
}

async function fetchLogin(d: OAuthDiscovery, accessToken: string): Promise<string | undefined> {
    try {
        const res = await fetchWithTimeout(
            `${d.keycloakUrl}/realms/${encodeURIComponent(d.realm)}/protocol/openid-connect/userinfo`,
            { headers: { Authorization: `Bearer ${accessToken}` } },
            8000
        );
        if (res.status !== 200) return undefined;
        const body = (await res.json()) as { preferred_username?: string; email?: string };
        return body.preferred_username || body.email;
    } catch {
        return undefined;
    }
}
