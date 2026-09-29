/**
 * ===============================
 *  Cerberus CLI — Types & Models
 * ===============================
 * Typages TypeScript pour les données récupérées via l’API publique Cerberus.
 *
 * Ces modèles couvrent :
 *  - La liste des test cases par application
 *  - Le détail complet d’un test case (steps, actions, contrôles, propriétés)
 *
 */

/** Contrôle (action de vérification dans une action) */
export interface TestControl {
    testFolderId: string;
    testcaseId: string;
    stepId: number;
    actionId: number;
    controlId: number;
    sort: number;
    conditionOperator: string;
    control: string;
    value1?: string;
    value2?: string;
    value3?: string;
    isFatal: boolean | "Y" | "N";
    description?: string;
    doScreenshotBefore: boolean | "Y" | "N";
    doScreenshotAfter: boolean | "Y" | "N";
    waitBefore: number;
    waitAfter: number;
    usrCreated?: string;
    dateCreated?: string;
    usrModif?: string;
    dateModif?: string;
}

/** Action exécutée dans une étape */
export interface TestAction {
    testFolderId: string;
    testcaseId: string;
    stepId: number;
    actionId: number;
    sort: number;
    conditionOperator: string;
    action: string;
    value1?: string;
    value2?: string;
    value3?: string;
    isFatal: boolean | "Y" | "N";
    description?: string;
    doScreenshotBefore: boolean | "Y" | "N";
    doScreenshotAfter: boolean | "Y" | "N";
    waitBefore: number;
    waitAfter: number;
    usrCreated?: string;
    dateCreated?: string;
    usrModif?: string;
    dateModif?: string;
    controls: TestControl[];
}

/** Étape d’un cas de test */
export interface TestCaseStep {
    testFolderId: string;
    testcaseId: string;
    stepId: number;
    sort: number | string;
    loop: string;
    conditionOperator: string;
    description?: string;
    isUsingLibraryStep: boolean;
    libraryStepStepId: number;
    isStepInUseByOtherTestcase: boolean;
    libraryStepSort: number;
    isLibraryStep: boolean;
    isExecutionForced: boolean;
    usrCreated?: string;
    dateCreated?: string;
    usrModif?: string;
    dateModif?: string;
    actions: TestAction[];
}

/** Pays associé à un cas de test */
export interface TestCaseCountry {
    idName: string;
    value: string;
    sort: number;
    description: string;
    attribute1?: string;
    attribute2?: string;
}

/** Propriété liée à un cas de test (avec éventuelles localisations par pays) */
export interface TestCaseProperty {
    testFolderId: string;
    testcaseId: string;
    property: string;
    type: string;
    value1?: string;
    value2?: string;
    value3?: string;
    length?: string;
    rowLimit?: number;
    nature?: string;
    rank?: number | string;
    dateCreated: string;
    dateModif: string;
    countries?: TestCaseCountry[];
}

/** Données détaillées d’un cas de test Cerberus */
export interface TestCaseDetailed {
    testFolderId: string;
    testcaseId: string;
    application: string;
    description: string;
    detailedDescription?: string;
    priority: number | string;
    version: number | string;
    status: string;
    isActive: boolean;
    isActiveQA: boolean;
    isActiveUAT: boolean;
    isActivePROD: boolean;
    conditionOperator: string;
    type: string;
    usrCreated: string;
    dateCreated: string;
    usrModif?: string;
    dateModif?: string;
    steps?: TestCaseStep[];
    properties?: TestCaseProperty[];
}

/** Modèle simplifié pour la liste des testcases d’une application */
export interface TestCase {
    testFolderId: string;
    testcaseId: string;
    application: string;
    description: string;
    detailedDescription?: string;
    priority: number | string;
    version: number | string;
    status: string;
    isActive: boolean;
    isActiveQA: boolean;
    isActiveUAT: boolean;
    isActivePROD: boolean;
    conditionOperator?: string;
    type: string;
    externalProvider?: string;
    implementer?: string;
    usrCreated: string;
    dateCreated: string;
    usrModif?: string;
    dateModif: string;
}

/** Réponse générique de l’API Cerberus */
export interface CerberusApiResponse<T> {
    data: T;
    statusCode: number;
    length: number;
    timestamp: string;
}

/** Réponse : détail d’un test case */
export type CerberusTestCaseResponse = CerberusApiResponse<TestCaseDetailed>;

/** Réponse : liste des testcases d’une application */
export type CerberusTestCaseByApplicationResponse = CerberusApiResponse<TestCase[]>;