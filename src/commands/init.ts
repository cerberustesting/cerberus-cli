import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { writeDslTypes } from "../dsl/dsl-types.js";

const SCHEMA_SRC = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../schema/cerberus-testcase.schema.json"
);

const BLOCK_START = "<!-- cerberus:start -->";
const BLOCK_END = "<!-- cerberus:end -->";

export interface InitOptions {
    apiUrl: string;
    application?: string;
    dir: string;
    force?: boolean;
}

function instructions(dir: string): string {
    return `${BLOCK_START}
## Tests Cerberus

Les tests fonctionnels vivent dans :
- \`${dir}/<testFolderId>/<testcaseId>/test.spec.ts\` : scénario Playwright-like éditable.
- \`${dir}/<testFolderId>/<testcaseId>/cerberus.yaml\` : métadonnées Cerberus.
- \`${dir}/<testFolderId>/<testcaseId>/.cerberus/state.json\` : état technique de round-trip, ne pas éditer manuellement.
- \`${dir}/<testFolderId>/<testcaseId>/.cerberus/conflict-vN.json\` : version serveur en conflit avec vos modifications locales, à résoudre puis supprimer.
- \`${dir}/.cerberus/cerberus-dsl.d.ts\` et \`${dir}/tsconfig.json\` : types du DSL pour l'IDE, régénérés par \`pull\`, ne pas éditer.

Commandes :
- \`cerberus pull\` : télécharge et convertit les tests vers le format local.
- \`cerberus validate\` : valide le DSL avant push.
- \`cerberus push [dossier/id ...]\` : envoie les tests modifiés localement, avec garde-fous. Il refuse si le serveur a changé depuis
  le dernier pull (utiliser \`merge\`), sauvegarde l'état serveur dans \`.cerberus/backups/\` avant l'envoi, puis relit le testcase et
  échoue si pays, propriétés ou étapes diffèrent. Options : \`--dry-run\`, \`--all\`, \`--force\` (écrase le serveur, à éviter).
- \`cerberus merge [dossier/id ...]\` : fusion à trois voies (dernier pull, local, serveur). Les conflits ne sont jamais tranchés
  en silence : sans option, rien n'est écrit ; \`--ours\` garde le local, \`--theirs\` garde le serveur, \`--dry-run\` prévisualise.
  Ce qui a disparu du serveur est conservé localement (\`--apply-deletions\` pour le supprimer aussi). Ne jamais supprimer les
  sauvegardes de \`.cerberus/backups/\` sans l'accord de l'utilisateur.
- \`cerberus run <dossier>/<testcaseId> [...]\` : lance des tests sur Cerberus et attend le résultat.
  Options : \`-f/--folder <dossier>\` (tous les tests locaux du dossier), \`-c/--country FR\`, \`-e/--env QA\`,
  \`-r/--robot <nom>\` (options répétables), \`--tag\`, \`--timeout <s>\`, \`--junit report.xml\`, \`--json\`, \`--no-wait\`.
  Pays, environnement et robot peuvent aussi venir de \`cerberus.config.json\`.
  Code de sortie : 0 tout OK, 1 test en échec, 2 erreur d'usage ou d'API.
  Le serveur exécute la version poussée : faire \`validate\` puis \`push\` avant \`run\` après une modification.
- Authentification, jamais dans le dépôt : \`cerberus login\` (OAuth via le navigateur si le serveur l'active, sinon clé API ; \`--api-key\` ou \`--oauth\` pour forcer), \`cerberus whoami\`, \`cerberus logout\`. En CI : variable \`CERBERUS_API_KEY\`.

Le DSL est volontairement contraint. Les actions courantes utilisent une syntaxe Playwright-like
(\`page.goto\`, \`page.evaluate\`, \`page.waitForTimeout\`) et les primitives Cerberus
utilisent \`cerberus.*\`. Les actions non mappées sont conservées avec \`cerberus.action(...)\`.
Les URL, durées, noms de propriété/action/contrôle doivent être des littéraux : \`cerberus validate\` refuse le reste.
Un \`cerberus.control(...)\` doit suivre l'action qu'il vérifie.
${BLOCK_END}
`;
}

/** Ajoute ou remplace le bloc Cerberus dans un fichier, sans toucher au reste. */
function upsertBlock(file: string, block: string, header = ""): void {
    if (!fs.existsSync(file)) {
        fs.writeFileSync(file, header + block, "utf8");
        return;
    }
    const current = fs.readFileSync(file, "utf8");
    const start = current.indexOf(BLOCK_START);
    const end = current.indexOf(BLOCK_END);
    if (start !== -1 && end > start) {
        const next = current.slice(0, start) + block.trimEnd() + current.slice(end + BLOCK_END.length);
        fs.writeFileSync(file, next, "utf8");
    } else {
        fs.writeFileSync(file, current.replace(/\n*$/, "\n\n") + block, "utf8");
    }
}

function ensureGitignore(root: string, entries: string[]): void {
    const file = path.join(root, ".gitignore");
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const lines = new Set(current.split(/\r?\n/).map((l) => l.trim()));
    const missing = entries.filter((e) => !lines.has(e));
    if (missing.length === 0) return;
    const sep = current === "" || current.endsWith("\n") ? "" : "\n";
    fs.writeFileSync(file, current + sep + missing.join("\n") + "\n", "utf8");
}

function mergeVscodeSettings(root: string, schemaRel: string, dir: string): void {
    const file = path.join(root, ".vscode", "settings.json");
    let settings: Record<string, any> = {};
    if (fs.existsSync(file)) {
        try {
            settings = JSON.parse(fs.readFileSync(file, "utf8"));
        } catch {
            console.warn("⚠️  .vscode/settings.json illisible (commentaires ?) : association du schéma ignorée.");
            return;
        }
    }
    settings["yaml.schemas"] = {
        ...(settings["yaml.schemas"] ?? {}),
        [schemaRel]: `${dir}/**/cerberus.yaml`,
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

export function initCommand(opts: InitOptions): void {
    const root = process.cwd();
    const configFile = path.join(root, "cerberus.config.json");
    const dir = opts.dir.replace(/^\.\//, "").replace(/\/$/, "");

    if (fs.existsSync(configFile) && !opts.force) {
        console.log("ℹ️  cerberus.config.json existe déjà (--force pour l'écraser).");
    } else {
        const config = {
            apiUrl: opts.apiUrl,
            apiVersion: "1",
            defaultBaseDir: `./${dir}`,
            ...(opts.application ? { application: opts.application } : {}),
        };
        fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n", "utf8");
        console.log("✅ cerberus.config.json créé");
    }

    const schemaDir = path.join(root, dir, ".cerberus");
    fs.mkdirSync(schemaDir, { recursive: true });
    fs.copyFileSync(SCHEMA_SRC, path.join(schemaDir, "cerberus-testcase.schema.json"));
    mergeVscodeSettings(root, `./${dir}/.cerberus/cerberus-testcase.schema.json`, dir);
    console.log("✅ Schéma installé et associé dans VS Code (extension YAML de Red Hat requise)");

    writeDslTypes(path.join(root, dir));
    console.log("✅ Types du DSL installés (tests/tsconfig.json + .cerberus/cerberus-dsl.d.ts)");

    ensureGitignore(root, ["cerberus.config.json", `${dir}/**/.cerberus/conflict-*.json`]);

    const block = instructions(dir);
    upsertBlock(path.join(root, "AGENTS.md"), block, "# Instructions pour les assistants IA\n\n");
    // Claude Code lit CLAUDE.md : on y référence AGENTS.md ou on y ajoute le bloc s'il existe déjà.
    const claude = path.join(root, "CLAUDE.md");
    if (fs.existsSync(claude)) upsertBlock(claude, block);
    else fs.writeFileSync(claude, "@AGENTS.md\n", "utf8");
    console.log("✅ AGENTS.md / CLAUDE.md mis à jour");

    console.log(`\nÉtape suivante :\n  cerberus-testing login\n  cerberus-testing pull`);
}
