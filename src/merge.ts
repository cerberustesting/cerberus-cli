import type { TestCaseDetailed } from "./types.js";
import { sameContent } from "./sync.js";

/**
 * Fusion à trois voies d'un testcase :
 *  - base   : dernier état synchronisé avec le serveur (state.json)
 *  - local  : ce que vous avez modifié
 *  - remote : état actuel du serveur
 * Règle de base pour chaque champ ou élément : si un seul côté a changé par rapport à la base, on prend ce
 * côté ; si les deux ont changé de la même façon, on prend cette valeur ; sinon c'est un conflit.
 */

export type Policy = "abort" | "ours" | "theirs";

export interface Conflict {
    path: string;
    base: unknown;
    local: unknown;
    remote: unknown;
}

export interface MergeResult {
    merged: TestCaseDetailed;
    conflicts: Conflict[];
    /** ce qui a été fusionné automatiquement, hors cas triviaux */
    notes: string[];
}

type Obj = Record<string, any>;

/** Champs gérés par le serveur : toujours repris de sa version. */
const SERVER_KEYS = new Set(["version", "dateModif", "dateCreated", "usrModif", "usrCreated", "testFolderId", "testcaseId"]);

interface ChildSpec {
    /** clé d'identité des éléments de la liste, ou null pour une liste de valeurs (ensemble) */
    key: ((item: Obj) => string) | null;
    /** fusion élément par élément quand les deux côtés ont modifié le même élément */
    children?: Record<string, ChildSpec>;
}

const byId = (field: string) => (item: Obj) => String(item[field]);

const CONTROL: ChildSpec = { key: byId("controlId") };
const ACTION: ChildSpec = { key: byId("actionId"), children: { controls: CONTROL } };
const STEP: ChildSpec = { key: byId("stepId"), children: { actions: ACTION } };
const COUNTRY: ChildSpec = { key: byId("value") };
const PROPERTY: ChildSpec = { key: byId("property"), children: { countries: COUNTRY } };

const TESTCASE_CHILDREN: Record<string, ChildSpec> = {
    steps: STEP,
    countries: COUNTRY,
    properties: PROPERTY,
};

/** Listes du testcase qu'on ne fusionne pas finement : reprises du serveur telles quelles. */
const REMOTE_ONLY = new Set(["inheritedProperties", "labels", "dependencies"]);

class Merger {
    conflicts: Conflict[] = [];
    notes: string[] = [];
    constructor(private policy: Policy, private applyRemoteDeletions: boolean) {}

    private conflict(path: string, b: unknown, l: any, r: any): any {
        this.conflicts.push({ path, base: b, local: l, remote: r });
        return this.policy === "theirs" ? r : l;
    }

    /** Valeur d'un champ ou d'un élément entier. */
    pick<T>(path: string, b: T, l: T, r: T): T {
        if (sameContent(l, r)) return l;
        if (sameContent(l, b)) {
            this.notes.push(`${path} : modifié sur le serveur, repris`);
            return r;
        }
        if (sameContent(r, b)) return l;
        return this.conflict(path, b, l, r);
    }

    /** Fusion champ par champ d'un objet dont certains champs sont des listes gérées à part. */
    entity(path: string, b: Obj | undefined, l: Obj, r: Obj, children: Record<string, ChildSpec>, skip: Set<string> = new Set()): Obj {
        const out: Obj = { ...r };
        const keys = new Set([...Object.keys(b ?? {}), ...Object.keys(l), ...Object.keys(r)]);
        for (const k of keys) {
            if (SERVER_KEYS.has(k)) continue;
            if (k in children || skip.has(k)) continue;
            const v = this.pick(path ? `${path}.${k}` : k, b?.[k], l[k], r[k]);
            if (v === undefined) delete out[k];
            else out[k] = v;
        }
        for (const [k, spec] of Object.entries(children)) {
            const merged = this.list(path ? `${path}.${k}` : k, b?.[k] ?? [], l[k] ?? [], r[k] ?? [], spec);
            if (merged.length > 0 || k in r || k in l) out[k] = merged;
        }
        return out;
    }

    list(path: string, b: Obj[], l: Obj[], r: Obj[], spec: ChildSpec): Obj[] {
        const key = spec.key ?? ((x: Obj) => JSON.stringify(x));
        const index = (xs: Obj[]) => new Map(xs.map((x) => [key(x), x]));
        const B = index(b);
        const L = index(l);
        const R = index(r);
        const order = [...R.keys(), ...[...L.keys()].filter((k) => !R.has(k))];
        const result: Obj[] = [];

        for (const id of order) {
            const p = `${path}[${id}]`;
            const inB = B.has(id);
            const inL = L.has(id);
            const inR = R.has(id);
            const bi = B.get(id);
            const li = L.get(id);
            const ri = R.get(id);

            if (inL && inR) {
                if (sameContent(li, ri)) result.push(ri!);
                else if (inB && spec.children) result.push(this.entity(p, bi, li!, ri!, spec.children));
                else if (inB) result.push(this.pick(p, bi as Obj, li!, ri!));
                else result.push(this.conflict(p, undefined, li!, ri!)); // ajouté des deux côtés, différemment
            } else if (inL) {
                if (!inB) {
                    this.notes.push(`${p} : ajouté localement, conservé`);
                    result.push(li!);
                } else if (sameContent(li, bi)) {
                    // Suppression côté serveur d'un élément que vous n'avez pas touché. Un serveur qui a perdu des
                    // données produit le même signal qu'une suppression voulue : on ne supprime donc pas sans accord.
                    if (this.applyRemoteDeletions || this.policy === "theirs") {
                        this.notes.push(`${p} : supprimé sur le serveur, supprimé aussi`);
                    } else {
                        this.notes.push(`⚠️  ${p} : absent du serveur, CONSERVÉ localement (--apply-deletions pour le supprimer aussi ; un push le recréera)`);
                        result.push(li!);
                    }
                } else {
                    const keep = this.conflict(p, bi, li, undefined as unknown as Obj); // supprimé serveur, modifié local
                    if (keep) result.push(keep);
                }
            } else if (inR) {
                if (!inB) {
                    this.notes.push(`${p} : ajouté sur le serveur, conservé`);
                    result.push(ri!);
                } else if (sameContent(ri, bi)) {
                    this.notes.push(`${p} : supprimé localement, supprimé aussi`);
                } else {
                    const keep = this.conflict(p, bi, undefined as unknown as Obj, ri); // supprimé local, modifié serveur
                    if (keep) result.push(keep);
                }
            }
        }

        if (!spec.key) return result;
        return result.sort((x, y) => (Number(x.sort) || 0) - (Number(y.sort) || 0));
    }
}

export function mergeTests(
    base: TestCaseDetailed,
    local: TestCaseDetailed,
    remote: TestCaseDetailed,
    policy: Policy = "abort",
    applyRemoteDeletions = false
): MergeResult {
    const m = new Merger(policy, applyRemoteDeletions);
    const merged = m.entity("", base as Obj, local as Obj, remote as Obj, TESTCASE_CHILDREN, REMOTE_ONLY);
    // champs du serveur (version, dates, listes non fusionnées) : ceux du serveur, ce qui est déjà le cas via { ...r }
    return { merged: merged as TestCaseDetailed, conflicts: m.conflicts, notes: m.notes };
}
