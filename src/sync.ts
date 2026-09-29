import fs from "fs";
import path from "path";
import YAML from "yaml";
import type { CerberusConfig } from "./config.js";
import { generateSpec, LocalState, toLocalMetadata } from "./dsl/local-format.js";
import type { CerberusTestCaseResponse, TestCaseDetailed } from "./types.js";

/** Champs propres au serveur : ignorés quand on compare deux versions d'un même élément. */
const VOLATILE_KEYS = new Set(["dateModif", "dateCreated", "usrModif", "usrCreated"]);

/** Représentation canonique pour comparer : Y/N ≡ booléen, "12" ≡ 12, clés triées, champs volatils retirés. */
export function canon(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canon);
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .filter(([k, v]) => !VOLATILE_KEYS.has(k) && v !== undefined && v !== null && v !== "")
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, v]) => [k, canon(v)])
        );
    }
    if (value === "Y") return true;
    if (value === "N") return false;
    if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
    return value;
}

export function sameContent(a: unknown, b: unknown): boolean {
    return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

export function testRef(t: { testFolderId: string; testcaseId: string }): string {
    return `${t.testFolderId}/${t.testcaseId}`;
}

// ---------------------------------------------------------------- état local

export function readState(testDir: string): LocalState | null {
    try {
        return JSON.parse(fs.readFileSync(path.join(testDir, ".cerberus", "state.json"), "utf8")) as LocalState;
    } catch {
        return null;
    }
}

/** Les fichiers locaux diffèrent-ils de ce que produirait le dernier état synchronisé (state.json) ? */
export function isLocallyModified(testDir: string): boolean {
    const metadataPath = path.join(testDir, "cerberus.yaml");
    const specPath = path.join(testDir, "test.spec.ts");
    if (!fs.existsSync(metadataPath) || !fs.existsSync(specPath)) return false;
    const state = readState(testDir);
    if (!state) return false;
    try {
        return (
            fs.readFileSync(metadataPath, "utf8") !== YAML.stringify(toLocalMetadata(state.serverPayload)) ||
            fs.readFileSync(specPath, "utf8") !== generateSpec(state.serverPayload)
        );
    } catch {
        return true;
    }
}

/** Copie l'état serveur avant d'être écrasé : dernier filet de sécurité. Renvoie le chemin. */
export function backupServerState(testDir: string, server: TestCaseDetailed): string {
    const dir = path.join(testDir, ".cerberus", "backups");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(dir, `${stamp}-server-v${server.version}.json`);
    fs.writeFileSync(file, JSON.stringify(server, null, 2) + "\n", "utf8");
    return file;
}

// ---------------------------------------------------------------- serveur

async function baseHeaders(config: CerberusConfig, extra: Record<string, string> = {}): Promise<Record<string, string>> {
    return {
        accept: "application/json",
        ...(await config.authHeaders()),
        "X-API-VERSION": config.apiVersion,
        ...extra,
    };
}

function testUrl(config: CerberusConfig, t: { testFolderId: string; testcaseId: string }): string {
    return `${config.apiUrl}/testcases/${encodeURIComponent(t.testFolderId)}/${encodeURIComponent(t.testcaseId)}`;
}

/** Message lisible pour une réponse HTTP en échec (dont les redirections vers la connexion). */
export async function describeHttpFailure(res: Response): Promise<string> {
    if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location") ?? "?";
        const toLogin = /oauth2\/authorization|keycloak|login/i.test(location);
        return (
            `redirection ${res.status} vers ${location}\n` +
            (toLogin
                ? "   Redirection vers la connexion : vous n'êtes pas authentifié ('whoami', 'login'),\n" +
                  "   ou le serveur a levé une erreur interne que sa page /error masque (voir les logs serveur)."
                : "   Vérifiez apiUrl (http/https, slash final).")
        );
    }
    return `${res.status} ${res.statusText} ${(await res.text()).slice(0, 500)}`.trimEnd();
}

/** Lit un testcase sur le serveur. Renvoie null s'il n'existe pas. */
export async function fetchServerTest(
    config: CerberusConfig,
    t: { testFolderId: string; testcaseId: string }
): Promise<TestCaseDetailed | null> {
    const res = await fetch(testUrl(config, t), { headers: await baseHeaders(config), redirect: "manual" });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Lecture de ${testRef(t)} impossible : ${await describeHttpFailure(res)}`);
    return ((await res.json()) as CerberusTestCaseResponse).data;
}

/** Envoie un testcase. Le GET omet bugs/conditionOptions quand ils sont vides ; le PUT les exige. */
export async function putServerTest(config: CerberusConfig, test: TestCaseDetailed, serverVersion: number | string): Promise<Response> {
    return fetch(testUrl(config, test), {
        method: "PUT",
        // pas de suivi automatique : une redirection change la méthode ou perd le corps
        redirect: "manual",
        headers: await baseHeaders(config, { "Content-Type": "application/json" }),
        body: JSON.stringify({
            ...test,
            // le serveur ajoute 1 à la version reçue : on part de sa version réelle pour ne jamais la faire reculer
            version: Number(serverVersion),
            bugs: (test as any).bugs ?? [],
            conditionOptions: (test as any).conditionOptions ?? [],
        }),
    });
}

// ---------------------------------------------------------------- résumé et vérification

export interface Summary {
    countries: string[];
    /** propriété → pays */
    properties: Record<string, string[]>;
    steps: number;
    actions: number;
    controls: number;
    header: Record<string, unknown>;
}

export function summarize(t: TestCaseDetailed): Summary {
    const steps = t.steps ?? [];
    const actions = steps.flatMap((s) => s.actions ?? []);
    return {
        countries: ((t as any).countries ?? []).map((c: any) => c.value ?? c).sort(),
        properties: Object.fromEntries(
            (t.properties ?? []).map((p) => [p.property, ((p.countries ?? []) as any[]).map((c) => c.value).sort()])
        ),
        steps: steps.length,
        actions: actions.length,
        controls: actions.reduce((n, a) => n + (a.controls?.length ?? 0), 0),
        header: canon({
            description: t.description,
            detailedDescription: t.detailedDescription,
            priority: t.priority,
            status: t.status,
            isActive: t.isActive,
            isActiveQA: t.isActiveQA,
            isActiveUAT: t.isActiveUAT,
            isActivePROD: t.isActivePROD,
        }) as Record<string, unknown>,
    };
}

/** Écarts entre ce qui a été envoyé et ce que le serveur renvoie ensuite. Vide = push fidèle. */
export function verifyPush(sent: TestCaseDetailed, got: TestCaseDetailed): string[] {
    const a = summarize(sent);
    const b = summarize(got);
    const problems: string[] = [];
    const list = (x: string[]) => (x.length ? x.join(",") : "aucun");

    if (list(a.countries) !== list(b.countries)) {
        problems.push(`pays : envoyés [${list(a.countries)}], serveur [${list(b.countries)}]`);
    }
    for (const name of new Set([...Object.keys(a.properties), ...Object.keys(b.properties)])) {
        if (!(name in b.properties)) problems.push(`propriété ${name} absente du serveur après le push`);
        else if (!(name in a.properties)) problems.push(`propriété ${name} présente sur le serveur mais pas dans le push`);
        else if (list(a.properties[name]) !== list(b.properties[name])) {
            problems.push(`propriété ${name} : pays envoyés [${list(a.properties[name])}], serveur [${list(b.properties[name])}]`);
        }
    }
    for (const k of ["steps", "actions", "controls"] as const) {
        if (a[k] !== b[k]) problems.push(`${k} : envoyés ${a[k]}, serveur ${b[k]}`);
    }
    for (const k of Object.keys(a.header)) {
        if (JSON.stringify(a.header[k]) !== JSON.stringify(b.header[k])) {
            problems.push(`${k} : envoyé ${JSON.stringify(a.header[k])}, serveur ${JSON.stringify(b.header[k])}`);
        }
    }
    return problems;
}

/** Ligne de résumé pour --dry-run : ce qui diffère entre l'état de départ et le local. */
export function describeChanges(base: TestCaseDetailed, local: TestCaseDetailed): string[] {
    const a = summarize(base);
    const b = summarize(local);
    const out: string[] = [];
    for (const k of Object.keys(b.header)) {
        if (JSON.stringify(a.header[k]) !== JSON.stringify(b.header[k])) out.push(`${k} : ${JSON.stringify(a.header[k])} → ${JSON.stringify(b.header[k])}`);
    }
    for (const k of ["steps", "actions", "controls"] as const) if (a[k] !== b[k]) out.push(`${k} : ${a[k]} → ${b[k]}`);
    if (!sameContent(base.steps, local.steps)) out.push("contenu des étapes/actions modifié");
    if (!sameContent(base.properties, local.properties)) out.push("propriétés modifiées");
    return out;
}

/** Remplace la base (state.json) sans toucher aux fichiers locaux. */
export function writeState(testDir: string, serverPayload: TestCaseDetailed): void {
    const state: LocalState = { formatVersion: 1, serverPayload };
    fs.mkdirSync(path.join(testDir, ".cerberus"), { recursive: true });
    fs.writeFileSync(path.join(testDir, ".cerberus", "state.json"), JSON.stringify(state, null, 2) + "\n", "utf8");
}

/** Sélectionne les dossiers de tests : références « Dossier/Id » ou tous. */
export function selectTestDirs(allDirs: string[], refs: string[]): string[] {
    if (refs.length === 0) return allDirs;
    const wanted = refs.map((r) => r.replace(/\/+$/, ""));
    const result: string[] = [];
    for (const ref of wanted) {
        const dir = allDirs.find((d) => d.split(path.sep).slice(-2).join("/") === ref);
        if (!dir) throw new Error(`Test local introuvable : ${ref} (attendu : <dossier>/<testcaseId>)`);
        result.push(dir);
    }
    return result;
}
