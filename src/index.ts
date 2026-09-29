#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Command } from "commander";
import { pullTests } from "./commands/pull.js";
import { pushCommand } from "./commands/push.js";
import { loginCommand } from "./commands/login.js";
import { initCommand } from "./commands/init.js";
import { validateCommand } from "./commands/validate.js";
import { runCommand } from "./commands/run.js";

const pkg = JSON.parse(
    fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8")
);

const program = new Command();

program
    .name("cerberus-testing-cli")
    .description("CLI Cerberus pour synchroniser les tests avec le serveur SaaS")
    .version(pkg.version);

program
    .command("pull")
    .description("Télécharge les tests du serveur Cerberus")
    .action(async () => {
        await pullTests();
    });

program
    .command("push")
    .description("Met à jour le serveur Cerberus avec les fichiers locaux")
    .action(async () => {
        await pushCommand();
    });

const collect = (value: string, previous: string[]): string[] => [...previous, value];

program
    .command("run [testcases...]")
    .description("Lance un ou plusieurs tests Cerberus et attend leur résultat")
    .option("-f, --folder <folder>", "lance tous les tests locaux d'un dossier", collect, [])
    .option("-c, --country <country>", "pays d'exécution (répétable)", collect, [])
    .option("-e, --env <environment>", "environnement d'exécution (répétable)", collect, [])
    .option("-r, --robot <robot>", "robot d'exécution (répétable)", collect, [])
    .option("--tag <tag>", "tag d'exécution Cerberus")
    .option("--timeout <seconds>", "délai maximum d'attente", "900")
    .option("--interval <seconds>", "intervalle de polling", "5")
    .option("--junit <file>", "écrit un rapport JUnit XML")
    .option("--json", "sortie JSON")
    .option("--no-wait", "n'attend pas la fin des exécutions")
    .action(async (testcases: string[], opts) => {
        const code = await runCommand(testcases ?? [], opts);
        if (code !== 0) process.exitCode = code;
    });

program
    .command("validate")
    .description("Valide les fichiers Cerberus locaux et le DSL Playwright-like")
    .action(async () => {
        await validateCommand();
    });

program
    .command("init")
    .description("Prépare le projet courant : config, schéma IDE, instructions pour assistants IA")
    .option("--api-url <url>", "URL de l'API publique Cerberus", "https://qa.cerberus-testing.com/api/public")
    .option("--application <name>", "application Cerberus à synchroniser")
    .option("--dir <path>", "dossier des tests", "tests")
    .option("--force", "écrase cerberus.config.json existant")
    .action((opts) => initCommand(opts));

program
    .command("login")
    .description("Enregistre la clé API hors du dépôt (~/.config/cerberus)")
    .option("--api-key <key>", "clé API (sinon saisie masquée)")
    .action(async (opts: { apiKey?: string }) => {
        await loginCommand(opts.apiKey);
    });

program.parseAsync().catch((err: Error) => {
    console.error(`❌ ${err.message}`);
    process.exit(1);
});