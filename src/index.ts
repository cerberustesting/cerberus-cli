#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Command } from "commander";
import { pullTests } from "./commands/pull.js";
import { pushCommand } from "./commands/push.js";
import { loginCommand, logoutCommand, whoamiCommand } from "./commands/login.js";
import { initCommand } from "./commands/init.js";
import { mergeCommand } from "./commands/merge.js";
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
    .command("push [tests...]")
    .description("Envoie les tests modifiés localement (avec garde-fous : serveur inchangé, sauvegarde, relecture)")
    .option("--all", "envoie aussi les tests sans modification locale")
    .option("--force", "envoie même si le serveur a changé depuis le dernier pull (écrase ses changements)")
    .option("--dry-run", "montre ce qui serait envoyé sans rien modifier")
    .action(async (tests: string[], opts) => {
        const code = await pushCommand(tests ?? [], opts);
        if (code !== 0) process.exitCode = code;
    });

program
    .command("merge [tests...]")
    .description("Fusionne l'état du serveur dans vos fichiers locaux (fusion à trois voies)")
    .option("--ours", "en cas de conflit, garde votre version locale")
    .option("--theirs", "en cas de conflit, garde la version du serveur")
    .option("--apply-deletions", "supprime aussi en local ce qui a été supprimé sur le serveur (sinon conservé, un push le recrée)")
    .option("--dry-run", "montre la fusion sans rien écrire")
    .action(async (tests: string[], opts) => {
        const code = await mergeCommand(tests ?? [], opts);
        if (code !== 0) process.exitCode = code;
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
    .description("S'authentifie : OAuth (navigateur) si le serveur l'active, sinon clé API")
    .option("--api-key [key]", "enregistre une clé API (saisie masquée si omise)")
    .option("--oauth", "force la connexion OAuth (Keycloak)")
    .option("--port <port>", "port local de la redirection OAuth", "18080")
    .option("--client-id <id>", "client Keycloak à utiliser (défaut : celui annoncé par le serveur)")
    .action(async (opts) => {
        await loginCommand(opts);
    });

program
    .command("logout")
    .description("Supprime les identifiants enregistrés (~/.config/cerberus)")
    .action(() => logoutCommand());

program
    .command("whoami")
    .description("Affiche le mode d'authentification actif")
    .action(() => whoamiCommand());

program.parseAsync().catch((err: Error) => {
    console.error(`❌ ${err.message}`);
    process.exit(1);
});