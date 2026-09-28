import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

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

Les tests fonctionnels vivent dans \`${dir}/<testFolderId>/<testcaseId>.yaml\`
et sont synchronisés avec le serveur Cerberus via le CLI \`cerberus-testing\`.

- \`cerberus-testing pull\` : télécharge les tests (les fichiers modifiés localement sont ignorés,
  un \`*.conflict-vN.yaml\` est créé si le serveur a une version plus récente).
- \`cerberus-testing push\` : envoie les fichiers locaux vers le serveur.
- La clé API n'est jamais dans le dépôt : \`cerberus-testing login\` ou \`CERBERUS_API_KEY\`.

Règles pour modifier un test :
- Ne pas modifier \`testFolderId\`, \`testcaseId\`, \`application\` (identifiants, lecture seule).
- \`priority\` : 1 (bloquant) à 5 (mineur). \`status\` : WORKING, READY ou OBSOLETE.
- Structure : \`steps[]\` → \`actions[]\` → \`controls[]\`. Garder les \`stepId\`/\`actionId\`/\`controlId\` cohérents.
- Schéma : \`${dir}/.cerberus/cerberus-testcase.schema.json\`.
- Ne pas éditer les fichiers \`*.conflict-*.yaml\` : résoudre le conflit puis les supprimer.
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
        [schemaRel]: `${dir}/**/*.yaml`,
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

    ensureGitignore(root, ["cerberus.config.json", `${dir}/*.conflict-*.yaml`, `${dir}/**/*.conflict-*.yaml`]);

    const block = instructions(dir);
    upsertBlock(path.join(root, "AGENTS.md"), block, "# Instructions pour les assistants IA\n\n");
    // Claude Code lit CLAUDE.md : on y référence AGENTS.md ou on y ajoute le bloc s'il existe déjà.
    const claude = path.join(root, "CLAUDE.md");
    if (fs.existsSync(claude)) upsertBlock(claude, block);
    else fs.writeFileSync(claude, "@AGENTS.md\n", "utf8");
    console.log("✅ AGENTS.md / CLAUDE.md mis à jour");

    console.log(`\nÉtape suivante :\n  cerberus-testing login\n  cerberus-testing pull`);
}
