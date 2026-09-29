import fs from "fs";
import path from "path";

const DSL_TYPES = `// Généré par Cerberus CLI : types du DSL natif Cerberus.
// Le fichier testcase.ts est interprété par le CLI, pas exécuté.

type CerberusFlag = boolean | "Y" | "N";
type CerberusScreenshot = "before" | "after" | "both" | "never";
type CerberusPropertyNature = "STATIC" | "RANDOM" | "RANDOMNEW" | "NOTINUSE" | "NotInUse";

interface CerberusFluentMetadata<T> {
    description(value: string): T;
    condition(value: string): T;
    fatal(value: boolean): T;
    screenshot(value: CerberusScreenshot): T;
    waitBefore(ms: number): T;
    waitAfter(ms: number): T;
    value1(value: string): T;
    value2(value: string): T;
    value3(value: string): T;
}

interface CerberusActionBuilder extends CerberusFluentMetadata<CerberusActionBuilder> {}
interface CerberusControlBuilder extends CerberusFluentMetadata<CerberusControlBuilder> {}

interface CerberusPropertyBuilder {
    value1(value: string): CerberusPropertyBuilder;
    value2(value: string): CerberusPropertyBuilder;
    value3(value: string): CerberusPropertyBuilder;
    database(name: string): CerberusPropertyBuilder;
    length(value: string | number): CerberusPropertyBuilder;
    rowLimit(value: number): CerberusPropertyBuilder;
    nature(value: CerberusPropertyNature): CerberusPropertyBuilder;
    rank(value: number): CerberusPropertyBuilder;
    retryNb(value: number): CerberusPropertyBuilder;
    retryPeriod(milliseconds: number): CerberusPropertyBuilder;
    cacheExpire(seconds: number): CerberusPropertyBuilder;
    description(value: string): CerberusPropertyBuilder;
    country(value: string): CerberusPropertyBuilder;
    countries(...values: string[]): CerberusPropertyBuilder;
}

interface CerberusProperty {
    define(definitions: Record<string, string | number | CerberusPropertyBuilder>): void;
    value(name: string): string;
    text(value?: string | number): CerberusPropertyBuilder;
    fromJson(path: string): CerberusPropertyBuilder;
    rawFromJson(path: string): CerberusPropertyBuilder;
    fromSql(query: string): CerberusPropertyBuilder;
    fromDataLib(name: string): CerberusPropertyBuilder;
    fromJS(expression?: string): CerberusPropertyBuilder;
    fromXml(xpath: string): CerberusPropertyBuilder;
    rawFromXml(xpath: string): CerberusPropertyBuilder;
    differencesFromXml(xpath: string): CerberusPropertyBuilder;
    fromHtml(locator: string): CerberusPropertyBuilder;
    fromHtmlVisible(locator: string): CerberusPropertyBuilder;
    attributeFromHtml(locator: string): CerberusPropertyBuilder;
    fromCookie(name: string): CerberusPropertyBuilder;
    fromNetworkTraffic(path: string): CerberusPropertyBuilder;
    fromGroovy(script: string): CerberusPropertyBuilder;
    fromCommand(command: string): CerberusPropertyBuilder;
    elementPosition(locator: string): CerberusPropertyBuilder;
    otp(secret: string): CerberusPropertyBuilder;
    fromExecutionObject(path: string): CerberusPropertyBuilder;
}

interface CerberusAction {
    openUrl(url: string): CerberusActionBuilder;
    feedField(element: string, value: string): CerberusActionBuilder;
    click(element: string): CerberusActionBuilder;
    wait(ms: number | string): CerberusActionBuilder;
    executeJS(script: string): CerberusActionBuilder;
    calculateProperty(name: string): CerberusActionBuilder;
    callService(name: string, options?: { kafkaEvents?: string | number; kafkaWaitSeconds?: string | number }): CerberusActionBuilder;
    custom(name: string, values?: { value1?: string; value2?: string; value3?: string }): CerberusActionBuilder;
    [name: string]: ((...args: any[]) => CerberusActionBuilder);
}

interface CerberusControl {
    custom(name: string, values?: { value1?: string; value2?: string; value3?: string }): CerberusControlBuilder;
    [name: string]: ((...args: any[]) => CerberusControlBuilder);
}

interface CerberusStep {
    (description: string, body: () => void): void;
    library(ref: { testFolder: string; testcase: string; step: number; description?: string }): void;
}

interface CerberusDataLib {
    value(name: string, subData: string): string;
}

declare function object(name: string): string;

interface CerberusScriptContext {
    step: CerberusStep;
    action: CerberusAction;
    control: CerberusControl;
    property: CerberusProperty;
    object: typeof object;
    datalib: CerberusDataLib;
}

interface CerberusTestcaseDefinition {
    name: string;
    application: string;
    tags?: string[];
    countries?: string[];
    priority?: string | number;
    status?: string;
    type?: string;
    detailedDescription?: string;
    active?: Array<"QA" | "UAT" | "PROD">;
    script: (ctx: CerberusScriptContext) => void;
}

interface CerberusRoot {
    testcase(definition: CerberusTestcaseDefinition): void;
}

declare const cerberus: CerberusRoot;

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

interface CerberusDataLibResource {
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
    data: Record<string, string | number | boolean>;
}
`

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
    include: [".cerberus/cerberus-dsl.d.ts", "tests/**/testcase.ts", "applicationObjects/**/*.ts", "services/**/*.ts", "datalib/**/*.ts"],
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
