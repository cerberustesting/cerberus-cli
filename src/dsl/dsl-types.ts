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

interface CerberusObjectRef {
    click(): Promise<void>;
    fill(value: string): Promise<void>;
}

interface CerberusServiceCallOptions {
    kafkaEvents?: string | number;
    kafkaWaitSeconds?: string | number;
}

interface CerberusServiceRef {
    call(options?: CerberusServiceCallOptions): Promise<void>;
}

interface Cerberus {
    step(description: string, body: () => Promise<void>): Promise<void>;
    /** Référence un ApplicationObject Cerberus par son nom. */
    object(name: string): CerberusObjectRef;
    /** Référence un service Cerberus et déclenche l'action callService. */
    service(name: string): CerberusServiceRef;
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

interface CerberusTestOptions {
    /** Playwright-compatible tags, mapped to existing Cerberus labels. */
    tag?: string | string[];
    annotation?: { type: string; description?: string } | Array<{ type: string; description?: string }>;
}

interface CerberusApplicationObject {
    application: string;
    object: string;
    value: string;
    screenshotFilename?: string;
    xOffset?: string;
    yOffset?: string;
}

interface CerberusService {
    service: string;
    application?: string;
    type: string;
    method: string;
    servicePath?: string;
    isFollowingRedirection?: boolean;
    fileName?: string;
    operation?: string;
    attachementURL?: string;
    serviceRequest?: string;
    serviceRequestExtra1?: string;
    kafkaTopic?: string;
    kafkaKey?: string;
    kafkaFilterPath?: string;
    kafkaFilterValue?: string;
    group?: string;
    description?: string;
    headers?: Array<Record<string, unknown>>;
    contents?: Array<Record<string, unknown>>;
}

interface CerberusDataLib {
    id?: number;
    name: string;
    system?: string;
    environment?: string;
    country?: string;
    type: "INTERNAL" | "SQL" | "SERVICE" | "FILE" | string;
    group?: string;
    privateData?: string;
    description?: string;
    database?: string;
    script?: string;
    databaseUrl?: string;
    service?: string;
    servicePath?: string;
    method?: string;
    envelope?: string;
    databaseCsv?: string;
    csvUrl?: string;
    separator?: string;
    ignoreFirstLine?: boolean;
    subData?: Array<Record<string, unknown>>;
}

declare function test(
    name: string,
    options: CerberusTestOptions,
    body: (fixtures: { page: CerberusPage; request: CerberusRequest; cerberus: Cerberus }) => Promise<void>
): void;
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
    include: [".cerberus/cerberus-dsl.d.ts", "**/*.spec.ts", "applicationObjects/**/*.ts", "services/**/*.ts", "datalib/**/*.ts"],
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
