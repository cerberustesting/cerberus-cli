import fs from "fs";
import path from "path";
import { writeDslTypes } from "../dsl/dsl-types.js";

const BLOCK_START = "<!-- cerberus:start -->";
const BLOCK_END = "<!-- cerberus:end -->";

export interface InitOptions {
    apiUrl: string;
    application?: string;
    system?: string;
    dir: string;
    force?: boolean;
}

function instructions(dir: string): string {
    return `${BLOCK_START}
## Cerberus DSL

Le workspace local vit dans :
- \`${dir}/tests/<testFolder>/<testcase>/testcase.ts\` : définition complète du testcase ;
- \`${dir}/tests/<testFolder>/<testcase>/.sync/baseline.json\` : baseline technique du dernier pull ;
- \`${dir}/applicationObjects/*.ts\`, \`${dir}/services/*.ts\`, \`${dir}/datalib/*.ts\` : ressources partagées ;
- \`${dir}/.cerberus/\` : types et catalogues techniques du workspace.

Un testcase est un DSL TypeScript déclaratif, interprété par le CLI et jamais exécuté :

\`\`\`ts
cerberus.testcase({
  name: "Login",
  application: "SHOP",
  tags: ["smoke"],
  countries: ["FR"],

  script: ({ step, action, control, property, object, datalib }) => {
    property.define({
      USER: property.fromDataLib("CERBERUS_USER")
    });

    step("Login", () => {
      action
        .feedField(object("USERNAME"), property.value("USER"))
        .description("Feed login")
        .fatal(false);

      action
        .click(object("LOGIN_BUTTON"))
        .description("Submit login");

      control.verifyTextContains(object("WELCOME"), "Welcome");
    });
  }
});
\`\`\`

Principes :
- \`cerberus.testcase({...})\` porte le header compact et le script ;
- \`property.*\` définit les propriétés ; \`property.value("X")\` référence \`%property.X%\` ;
- \`step(...)\` structure le scénario ; \`step.library(...)\` référence un step de librairie ;
- \`action.*\` exécute les actions Cerberus ; les attributs se chaînent avec \`.description()\`, \`.fatal()\`, \`.condition()\`, \`.screenshot()\`, \`.waitBefore()\`, \`.waitAfter()\` ;
- \`control.*\` exprime les contrôles Cerberus et se rattache à l'action précédente du même step ;
- \`object("NAME")\` référence \`%object.NAME.value%\` ;
- \`datalib.value("NAME", "SUBDATA")\` référence \`%datalib.NAME.SUBDATA%\` ;
- \`action.custom(...)\` et \`control.custom(...)\` sont les escape hatches pour les capacités non encore typées.

Commandes :
- \`cerberus pull\` synchronise tests et ressources ;
- \`cerberus prepare [dossier/id ...]\` analyse la structure du DSL sans mutation ;
- \`cerberus validate\` valide le DSL ;
- \`cerberus push [dossier/id ...]\` pousse les changements, avec \`--dry-run\`, \`--all\`, \`--force\` ;
- \`cerberus merge [dossier/id ...]\` fusionne base/local/serveur ;
- \`cerberus run <dossier>/<testcaseId> [...]\` exécute la version poussée sur Cerberus.

Pour créer un testcase local, créer simplement \`${dir}/tests/<testFolder>/<nom>/testcase.ts\` sans \`.sync/baseline.json\`. Le premier push crée le testcase côté Cerberus.
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


function ensureWorkspaceLayout(root: string, dir: string): void {
    const workspace = path.join(root, dir);
    for (const name of ["tests", "applicationObjects", "services", "datalib"]) {
        const target = path.join(workspace, name);
        fs.mkdirSync(target, { recursive: true });
        const keep = path.join(target, ".gitkeep");
        if (!fs.existsSync(keep)) fs.writeFileSync(keep, "", "utf8");
    }
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
            ...(opts.system ? { system: opts.system } : {}),
        };
        fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n", "utf8");
        console.log("✅ cerberus.config.json créé");
    }

    ensureWorkspaceLayout(root, dir);
    console.log("✅ Workspace Cerberus créé (tests, applicationObjects, services, datalib)");

    fs.mkdirSync(path.join(root, dir, ".cerberus"), { recursive: true });

    writeDslTypes(path.join(root, dir));
    console.log(`✅ Types du DSL installés (${dir}/tsconfig.json + ${dir}/.cerberus/cerberus-dsl.d.ts)`);

    ensureGitignore(root, ["cerberus.config.json", `${dir}/**/.sync/conflict-*.json`]);

    const block = instructions(dir);
    upsertBlock(path.join(root, "AGENTS.md"), block, "# Instructions pour les assistants IA\n\n");
    // Claude Code lit CLAUDE.md : on y référence AGENTS.md ou on y ajoute le bloc s'il existe déjà.
    const claude = path.join(root, "CLAUDE.md");
    if (fs.existsSync(claude)) upsertBlock(claude, block);
    else fs.writeFileSync(claude, "@AGENTS.md\n", "utf8");
    console.log("✅ AGENTS.md / CLAUDE.md mis à jour");

    console.log(`\nÉtape suivante :\n  cerberus-testing login\n  cerberus-testing pull`);
}
