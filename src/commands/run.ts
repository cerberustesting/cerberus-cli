import fs from "fs";
import path from "path";
import YAML from "yaml";
import { loadConfig, CerberusConfig, testsDir } from "../config.js";
import { ExecutionResult, toJUnit, verdictOf } from "../junit.js";

export interface RunOptions {
    folder?: string[];
    country?: string[];
    env?: string[];
    robot?: string[];
    tag?: string;
    timeout: string;
    interval: string;
    junit?: string;
    json?: boolean;
    wait: boolean;
}

interface Ref {
    testFolderId: string;
    testcaseId: string;
}

/** "Folder/0001A" → ref. */
function parseRef(arg: string): Ref {
    const [testFolderId, testcaseId, ...rest] = arg.split("/");
    if (!testFolderId || !testcaseId || rest.length) {
        throw new Error(`Référence invalide '${arg}' (attendu : <dossier>/<testcaseId>)`);
    }
    return { testFolderId, testcaseId };
}

/** Tous les testcases locaux d'un dossier.
 * Supporte le layout natif <folder>/<testcase>/testcase.ts
 * et, pour compatibilité, l'ancien layout <folder>/<testcase>.yaml.
 */
function refsFromFolder(config: CerberusConfig, folder: string): Ref[] {
    const dir = path.join(testsDir(config), folder);
    if (!fs.existsSync(dir)) throw new Error(`Dossier local introuvable : ${dir}`);

    const refs: Ref[] = [];

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;

        if (entry.isDirectory()) {
            const testDir = path.join(dir, entry.name);
            migrateLegacyTestLayout(testDir);
            const testcasePath = path.join(testDir, "testcase.ts");
            if (!fs.existsSync(testcasePath)) continue;

            const data = YAML.parse(fs.readFileSync(metadataPath, "utf8"));
            refs.push({
                testFolderId: data.testFolder ?? data.testFolderId ?? folder,
                testcaseId: data.testcase ?? data.testcaseId ?? entry.name,
            });
            continue;
        }

        if (entry.isFile() && /\.ya?ml$/.test(entry.name) && !entry.name.includes(".conflict-")) {
            const data = YAML.parse(fs.readFileSync(path.join(dir, entry.name), "utf8"));
            refs.push({
                testFolderId: data.testFolderId ?? data.testFolder ?? folder,
                testcaseId:
                    data.testcaseId ??
                    data.testcase ??
                    entry.name.replace(/\.ya?ml$/, ""),
            });
        }
    }

    return refs;
}

async function api<T>(config: CerberusConfig, method: string, url: string, body?: unknown): Promise<T> {
    const res = await fetch(`${config.apiUrl}${url}`, {
        method,
        headers: {
            accept: "application/json",
            ...(await config.authHeaders()),
            "X-API-VERSION": config.apiVersion,
            ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`Erreur API ${res.status} sur ${method} ${url} - ${await res.text()}`);
    const json = (await res.json()) as { data?: T };
    return (json.data ?? json) as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PENDING = new Set(["PE", "QU"]);

/**
 * Codes de sortie : 0 = tout OK, 1 = au moins un test en échec/erreur,
 * 2 = erreur d'usage, d'API ou délai dépassé.
 */
export async function runCommand(testcases: string[], opts: RunOptions): Promise<number> {
    const config = loadConfig();

    const refs = [
        ...testcases.map(parseRef),
        ...(opts.folder ?? []).flatMap((f) => refsFromFolder(config, f)),
    ];
    if (refs.length === 0) throw new Error("Aucun test à lancer : passez <dossier>/<id> ou --folder.");

    const countries = opts.country ?? (config.country ? [config.country] : []);
    const environments = opts.env ?? (config.environment ? [config.environment] : []);
    const robots = opts.robot ?? (config.robot ? [config.robot] : []);
    if (!countries.length || !environments.length) {
        throw new Error("Pays et environnement requis : --country/--env ou country/environment dans cerberus.config.json.");
    }

    const say = (m: string) => (opts.json ? console.error(m) : console.log(m));
    say(`🚀 Mise en file de ${refs.length} test(s) sur ${countries.join(",")}/${environments.join(",")}...`);

    const queued = await api<{ tag: string; nbExecutions: number; messages?: string[] }>(
        config,
        "POST",
        "/queuedexecutions/",
        { testcases: refs, countries, environments, robots, tag: opts.tag }
    );
    queued.messages?.forEach((m) => say(`   ℹ️  ${m}`));
    if (!queued.nbExecutions) throw new Error("Aucune exécution créée (tests inactifs, environnement ou robot introuvable ?).");
    say(`   tag : ${queued.tag} — ${queued.nbExecutions} exécution(s)`);

    let results: ExecutionResult[] = [];
    if (opts.wait) {
        const deadline = Date.now() + Number(opts.timeout) * 1000;
        for (;;) {
            const exec = await api<{ executions?: any[] }>(config, "GET", `/campaignexecutions/${encodeURIComponent(queued.tag)}`);
            const list = exec.executions ?? [];
            results = list.map((e) => ({
                testFolderId: e.testcase?.testFolderId ?? "",
                testcaseId: e.testcase?.testcaseId ?? "",
                description: e.description,
                country: e.country?.value,
                environment: e.environment?.value,
                controlStatus: e.controlStatus ?? "PE",
                controlMessage: e.controlMessage,
                durationInMillis: e.durationInMillis ?? 0,
                executionId: e.testcaseExecutionId,
            }));
            const done = results.length >= queued.nbExecutions && results.every((r) => !PENDING.has(r.controlStatus));
            if (done) break;
            if (Date.now() > deadline) {
                say(`⏱️  Délai dépassé (${opts.timeout}s), résultats partiels.`);
                // les exécutions non terminées restent en PE/QU → comptées en erreur
                while (results.length < queued.nbExecutions) {
                    results.push({ testFolderId: "", testcaseId: "(en attente)", controlStatus: "QU", controlMessage: "Timeout avant exécution", durationInMillis: 0 });
                }
                break;
            }
            await sleep(Number(opts.interval) * 1000);
        }
    }

    if (opts.junit) {
        fs.mkdirSync(path.dirname(path.resolve(opts.junit)), { recursive: true });
        fs.writeFileSync(opts.junit, toJUnit(queued.tag, results), "utf8");
        say(`📄 Rapport JUnit : ${opts.junit}`);
    }

    const failed = results.filter((r) => ["failure", "error"].includes(verdictOf(r.controlStatus)));
    if (opts.json) {
        console.log(JSON.stringify({ tag: queued.tag, total: results.length, failed: failed.length, results }, null, 2));
    } else if (opts.wait) {
        for (const r of results) {
            const icon = verdictOf(r.controlStatus) === "pass" ? "✅" : verdictOf(r.controlStatus) === "skipped" ? "⏭️ " : "❌";
            console.log(`${icon} ${r.testFolderId}/${r.testcaseId} [${r.controlStatus}] ${r.controlMessage ?? ""}`.trimEnd());
        }
        console.log(`\n${failed.length ? "❌" : "✅"} ${results.length - failed.length}/${results.length} OK`);
    } else {
        console.log(`Tag : ${queued.tag}`);
    }
    return opts.wait && failed.length ? 1 : 0;
}
