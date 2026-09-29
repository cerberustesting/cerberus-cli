import fs from "fs";
import path from "path";

const DSL_TYPES = `// Généré par Cerberus CLI : types du DSL pour l'IDE (ne pas éditer, régénéré par pull/init).
// Le DSL est interprété par le CLI, pas exécuté par Playwright.

type CerberusFlag = boolean | "Y" | "N";

interface CerberusActionOptions {
    value1?: string;
    value2?: string;
    value3?: string;
    conditionOperator?: string;
    isFatal?: CerberusFlag;
    doScreenshotBefore?: CerberusFlag;
    doScreenshotAfter?: CerberusFlag;
    waitBefore?: number;
    waitAfter?: number;
    description?: string;
}

interface CerberusPage {
    /** Action Cerberus openUrl. L'URL doit être un littéral. */
    goto(url: string): Promise<void>;
    /** Action Cerberus wait. La durée doit être un littéral (ms). */
    waitForTimeout(ms: number): Promise<void>;
    /** Action Cerberus executeJS. Le corps de la fonction est envoyé tel quel au navigateur. */
    evaluate(fn: () => unknown): Promise<void>;
}

interface Cerberus {
    step(description: string, body: () => Promise<void>): Promise<void>;
    /** Action Cerberus non mappée sur page.*. */
    action(name: string, options?: CerberusActionOptions): Promise<void>;
    /** Contrôle Cerberus : doit suivre une action. */
    control(name: string, options?: CerberusActionOptions): Promise<void>;
    calculateProperty(property: string): Promise<void>;
}

declare function test(
    name: string,
    body: (fixtures: { page: CerberusPage; cerberus: Cerberus }) => Promise<void>
): void;

// Le code d'action executeJS de Cerberus installe ces propriétés sur la console du navigateur.
interface Console {
    stdlog: Function;
    logs: string[];
}
`;

const TSCONFIG = {
    compilerOptions: {
        target: "ES2020",
        module: "ESNext",
        moduleResolution: "Bundler",
        lib: ["ES2020", "DOM"],
        strict: true,
        noEmit: true,
        skipLibCheck: true,
    },
    include: [".cerberus/cerberus-dsl.d.ts", "**/*.spec.ts"],
};

/** Écrit les types du DSL et un tsconfig minimal (créé seulement s'il n'existe pas) dans le dossier des tests. */
export function writeDslTypes(baseDir: string): void {
    fs.mkdirSync(path.join(baseDir, ".cerberus"), { recursive: true });
    fs.writeFileSync(path.join(baseDir, ".cerberus", "cerberus-dsl.d.ts"), DSL_TYPES, "utf8");
    const tsconfig = path.join(baseDir, "tsconfig.json");
    if (!fs.existsSync(tsconfig)) {
        fs.writeFileSync(tsconfig, JSON.stringify(TSCONFIG, null, 2) + "\n", "utf8");
    }
}
