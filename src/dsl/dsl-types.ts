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

interface CerberusMetadata {
    description?: string;
    condition?: string;
    fatal?: boolean;
    screenshot?: "before" | "after" | "both" | "never";
    waitBefore?: number;
    waitAfter?: number;
}

interface CerberusLocator {
    click(): Promise<void>;
    fill(value: string): Promise<void>;
}

interface CerberusPage {
    /** Action Cerberus openUrl. L'URL doit être un littéral. */
    goto(url: string): Promise<void>;
    /** Sélecteur Playwright-like. */
    locator(selector: string): CerberusLocator;
    /** Action Cerberus wait. La durée doit être un littéral (ms). */
    waitForTimeout(ms: number): Promise<void>;
    /** Action Cerberus executeJS. Le corps de la fonction est envoyé tel quel au navigateur. */
    evaluate(fn: () => unknown): Promise<void>;
}

interface CerberusRequestOptions {
    data?: unknown;
    headers?: Record<string, string>;
    params?: Record<string, string | number | boolean>;
    timeout?: number;
    failOnStatusCode?: boolean;
}

interface CerberusApiResponse {
    ok(): boolean;
    status(): number;
    text(): Promise<string>;
    json(): Promise<unknown>;
}

interface CerberusRequest {
    /**
     * Vocabulaire réservé à l'API Playwright request.*.
     * Ces appels ne sont convertis vers Cerberus que lorsqu'un mapping sémantiquement équivalent existe.
     */
    get(url: string, options?: CerberusRequestOptions): Promise<CerberusApiResponse>;
    post(url: string, options?: CerberusRequestOptions): Promise<CerberusApiResponse>;
    put(url: string, options?: CerberusRequestOptions): Promise<CerberusApiResponse>;
    patch(url: string, options?: CerberusRequestOptions): Promise<CerberusApiResponse>;
    delete(url: string, options?: CerberusRequestOptions): Promise<CerberusApiResponse>;
}

interface CerberusLibraryStepRef {
    testFolder: string;
    testcase: string;
    step: number;
    description?: string;
}

interface Cerberus {
    step(description: string, body: () => Promise<void>): Promise<void>;
    /** Référence un step de librairie Cerberus sans dupliquer ses actions. */
    libraryStep(ref: CerberusLibraryStepRef): Promise<void>;
    /** Enrichit une action Playwright-like avec les métadonnées d'exécution Cerberus. */
    do<T>(action: Promise<T>, metadata?: CerberusMetadata): Promise<T>;
    /** Action Cerberus non mappée sur page.*. */
    action(name: string, options?: CerberusActionOptions): Promise<void>;
    /** Contrôle Cerberus : doit suivre une action. */
    control(name: string, options?: CerberusActionOptions): Promise<void>;
    calculateProperty(property: string): Promise<void>;
}

declare function test(
    name: string,
    body: (fixtures: { page: CerberusPage; request: CerberusRequest; cerberus: Cerberus }) => Promise<void>
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
