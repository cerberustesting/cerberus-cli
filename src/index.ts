#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Command } from "commander";
import { pullTests } from "./commands/pull.js";
import { pushCommand } from "./commands/push.js";
import { loginCommand } from "./commands/login.js";
import { initCommand } from "./commands/init.js";

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