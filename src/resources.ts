import fs from "fs";
import path from "path";
import YAML from "yaml";
import type { CerberusConfig, CerberusWorkspacePaths } from "./config.js";
import { workspacePaths } from "./config.js";
import { canon, sameContent } from "./sync.js";

export type ResourceKind = "applicationObjects" | "services" | "datalib" | "labels";
type Payload = Record<string, any>;

interface ResourceSpec {
  kind: ResourceKind;
  dir: keyof Pick<CerberusWorkspacePaths, "applicationObjects" | "services" | "datalib" | "labels">;
  listPath(config: CerberusConfig): string;
  getPath(payload: Payload, config: CerberusConfig): string | undefined;
  createPath(payload: Payload, config: CerberusConfig): string;
  updatePath(payload: Payload, config: CerberusConfig): string | undefined;
  identity(payload: Payload): string;
  naturalIdentity?(payload: Payload): string;
  fileName(payload: Payload): string;
  editable(payload: Payload): Payload;
  validate(payload: Payload, file: string): string[];
  hydrateListItem?: boolean;
}

interface ResourceState {
  formatVersion: 1;
  serverPayload: Payload;
}

const VOLATILE = new Set([
  "usrCreated", "dateCreated", "usrModif", "dateModif",
  "creator", "created", "lastModifier", "lastModified",
]);

function safeName(value: unknown): string {
  const text = String(value ?? "")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  return text || "unnamed";
}

function withoutVolatile(payload: Payload, remove: string[] = []): Payload {
  return Object.fromEntries(
    Object.entries(payload).filter(([key]) => !VOLATILE.has(key) && !remove.includes(key))
  );
}

function required(payload: Payload, file: string, fields: string[]): string[] {
  return fields
    .filter((f) => payload[f] === undefined || payload[f] === null || String(payload[f]).trim() === "")
    .map((f) => `${file} - champ obligatoire manquant : ${f}`);
}

const specs: ResourceSpec[] = [
  {
    kind: "applicationObjects",
    dir: "applicationObjects",
    listPath: (c) => `/applicationobjects/${encodeURIComponent(c.application ?? "")}`,
    getPath: (p) =>
      p.application && p.object
        ? `/applicationobjects/${encodeURIComponent(p.application)}/${encodeURIComponent(p.object)}`
        : undefined,
    createPath: (p, c) => `/applicationobjects/${encodeURIComponent(p.application ?? c.application ?? "")}`,
    updatePath: (p) =>
      p.application && p.object
        ? `/applicationobjects/${encodeURIComponent(p.application)}/${encodeURIComponent(p.object)}`
        : undefined,
    identity: (p) => `${p.application ?? ""}/${p.object ?? ""}`,
    fileName: (p) => `${safeName(p.object)}.yaml`,
    editable: (p) => withoutVolatile(p, ["id"]),
    validate: (p, file) => required(p, file, ["application", "object"]),
  },
  {
    kind: "services",
    dir: "services",
    listPath: (c) => `/services${c.application ? `?application=${encodeURIComponent(c.application)}` : ""}`,
    getPath: (p) => (p.service ? `/services/${encodeURIComponent(p.service)}` : undefined),
    createPath: () => "/services",
    updatePath: (p) => (p.service ? `/services/${encodeURIComponent(p.service)}` : undefined),
    identity: (p) => String(p.service ?? ""),
    fileName: (p) => `${safeName(p.service)}.yaml`,
    editable: (p) => withoutVolatile(p),
    validate: (p, file) => required(p, file, ["service", "type", "method"]),
    hydrateListItem: true,
  },
  {
    kind: "datalib",
    dir: "datalib",
    listPath: (c) => {
      const system = (c as any).system as string | undefined;
      return `/datalibs${system ? `?system=${encodeURIComponent(system)}` : ""}`;
    },
    getPath: (p) => (p.id !== undefined && p.id !== null ? `/datalibs/${encodeURIComponent(p.id)}` : undefined),
    createPath: () => "/datalibs",
    updatePath: (p) => (p.id !== undefined && p.id !== null ? `/datalibs/${encodeURIComponent(p.id)}` : undefined),
    identity: (p) => p.id != null ? String(p.id) : `${p.name ?? ""}|${p.system ?? ""}|${p.environment ?? ""}|${p.country ?? ""}`,
    naturalIdentity: (p) => `${p.name ?? ""}|${p.system ?? ""}|${p.environment ?? ""}|${p.country ?? ""}|${p.type ?? ""}`,
    fileName: (p) => p.id != null ? `${p.id} - ${safeName(p.name)}.yaml` : `${safeName(p.name)}.yaml`,
    editable: (p) => withoutVolatile(p),
    validate: (p, file) => required(p, file, ["name", "type"]),
    hydrateListItem: true,
  },
  {
    kind: "labels",
    dir: "labels",
    listPath: (c) => {
      const system = (c as any).system as string | undefined;
      return `/labels${system ? `?system=${encodeURIComponent(system)}` : ""}`;
    },
    getPath: (p) => (p.id !== undefined && p.id !== null ? `/labels/${encodeURIComponent(p.id)}` : undefined),
    createPath: () => "/labels",
    updatePath: (p) => (p.id !== undefined && p.id !== null ? `/labels/${encodeURIComponent(p.id)}` : undefined),
    identity: (p) => p.id != null ? String(p.id) : `${p.system ?? ""}|${p.type ?? ""}|${p.label ?? ""}`,
    naturalIdentity: (p) => `${p.system ?? ""}|${p.type ?? ""}|${p.label ?? ""}`,
    fileName: (p) => p.id != null ? `${p.id} - ${safeName(p.label)}.yaml` : `${safeName(p.label)}.yaml`,
    editable: (p) => withoutVolatile(p),
    validate: (p, file) => required(p, file, ["label", "type"]),
  },
];

async function api<T>(config: CerberusConfig, method: string, url: string, body?: unknown): Promise<{ status: number; data?: T; text?: string }> {
  const res = await fetch(`${config.apiUrl}${url}`, {
    method,
    redirect: "manual",
    headers: {
      accept: "application/json",
      ...(await config.authHeaders()),
      "X-API-VERSION": config.apiVersion,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404) return { status: 404 };
  if (!res.ok) return { status: res.status, text: (await res.text()).slice(0, 1000) };
  const json = (await res.json()) as { data?: T };
  return { status: res.status, data: (json.data ?? json) as T };
}

function resourceDir(paths: CerberusWorkspacePaths, spec: ResourceSpec): string {
  return paths[spec.dir];
}

function statePath(dir: string, fileName: string): string {
  return path.join(dir, ".cerberus", fileName.replace(/\.ya?ml$/i, ".json"));
}

function writeResource(dir: string, spec: ResourceSpec, payload: Payload): string {
  fs.mkdirSync(dir, { recursive: true });
  const fileName = spec.fileName(payload);
  const file = path.join(dir, fileName);
  fs.writeFileSync(file, YAML.stringify(spec.editable(payload)), "utf8");
  const state: ResourceState = { formatVersion: 1, serverPayload: payload };
  const stateFile = statePath(dir, fileName);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n", "utf8");
  return file;
}

function readState(dir: string, fileName: string): ResourceState | null {
  try {
    return JSON.parse(fs.readFileSync(statePath(dir, fileName), "utf8")) as ResourceState;
  } catch {
    return null;
  }
}

function readYaml(file: string): Payload {
  const parsed = YAML.parse(fs.readFileSync(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${file} doit contenir un objet YAML.`);
  }
  return parsed as Payload;
}

function yamlFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.ya?ml$/i.test(e.name))
    .map((e) => path.join(dir, e.name));
}

function locallyModified(dir: string, spec: ResourceSpec, file: string): boolean {
  const fileName = path.basename(file);
  const state = readState(dir, fileName);
  if (!state) return true;
  try {
    return !sameContent(readYaml(file), spec.editable(state.serverPayload));
  } catch {
    return true;
  }
}

function findExistingFile(dir: string, spec: ResourceSpec, payload: Payload): string | undefined {
  const wanted = spec.identity(payload);
  for (const file of yamlFiles(dir)) {
    try {
      if (spec.identity(readYaml(file)) === wanted) return file;
    } catch {
      // validation reports malformed YAML separately
    }
  }
  return undefined;
}

async function fullPayload(config: CerberusConfig, spec: ResourceSpec, item: Payload): Promise<Payload> {
  if (!spec.hydrateListItem) return item;
  const url = spec.getPath(item, config);
  if (!url) return item;
  const res = await api<Payload>(config, "GET", url);
  if (res.status !== 200 || !res.data) {
    throw new Error(`Impossible de relire ${spec.kind} ${spec.identity(item)} : HTTP ${res.status} ${res.text ?? ""}`);
  }
  return res.data;
}

export async function pullResources(config: CerberusConfig): Promise<void> {
  const paths = workspacePaths(config);

  for (const spec of specs) {
    if ((spec.kind === "applicationObjects" || spec.kind === "services") && !config.application) {
      console.warn(`⚠️ ${spec.kind} ignoré : application absente de cerberus.config.json`);
      continue;
    }

    const list = await api<Payload[]>(config, "GET", spec.listPath(config));
    if (list.status !== 200 || !Array.isArray(list.data)) {
      throw new Error(`Pull ${spec.kind} impossible : HTTP ${list.status} ${list.text ?? ""}`);
    }

    const dir = resourceDir(paths, spec);
    fs.mkdirSync(dir, { recursive: true });
    let written = 0;
    let conflicts = 0;

    for (const shallow of list.data) {
      const payload = await fullPayload(config, spec, shallow);
      const existing = findExistingFile(dir, spec, payload);
      if (existing && locallyModified(dir, spec, existing)) {
        const conflictDir = path.join(dir, ".cerberus", "conflicts");
        fs.mkdirSync(conflictDir, { recursive: true });
        fs.writeFileSync(
          path.join(conflictDir, spec.fileName(payload).replace(/\.ya?ml$/i, ".server.json")),
          JSON.stringify(payload, null, 2) + "\n",
          "utf8"
        );
        conflicts++;
        continue;
      }

      if (existing && path.basename(existing) !== spec.fileName(payload)) {
        const target = path.join(dir, spec.fileName(payload));
        if (!fs.existsSync(target)) fs.renameSync(existing, target);
      }
      writeResource(dir, spec, payload);
      written++;
    }

    console.log(`📦 ${spec.kind} : ${written} synchronisé(s)${conflicts ? `, ${conflicts} conflit(s) local(aux) préservé(s)` : ""}`);
  }
}

export function validateResources(config: CerberusConfig): string[] {
  const paths = workspacePaths(config);
  const issues: string[] = [];

  for (const spec of specs) {
    const dir = resourceDir(paths, spec);
    for (const file of yamlFiles(dir)) {
      try {
        const payload = readYaml(file);
        issues.push(...spec.validate(payload, path.relative(process.cwd(), file)));
        if (spec.kind === "applicationObjects" && config.application && payload.application !== config.application) {
          issues.push(`${path.relative(process.cwd(), file)} - application '${payload.application}' différente de l'application configurée '${config.application}'.`);
        }
        if (spec.kind === "services" && config.application && payload.application && payload.application !== config.application) {
          issues.push(`${path.relative(process.cwd(), file)} - application '${payload.application}' différente de l'application configurée '${config.application}'.`);
        }
      } catch (err) {
        issues.push(`${path.relative(process.cwd(), file)} - ${(err as Error).message}`);
      }
    }
  }
  return issues;
}

export interface PushResourceOptions { dryRun?: boolean; all?: boolean; force?: boolean; }

export async function pushResources(config: CerberusConfig, opts: PushResourceOptions): Promise<number> {
  const paths = workspacePaths(config);
  let pushed = 0;
  let unchanged = 0;
  let blocked = 0;
  let failed = 0;

  for (const spec of specs) {
    const dir = resourceDir(paths, spec);
    for (const file of yamlFiles(dir)) {
      const fileName = path.basename(file);
      let local: Payload;
      try {
        local = readYaml(file);
        const validation = spec.validate(local, path.relative(process.cwd(), file));
        if (validation.length) {
          validation.forEach((x) => console.error(`❌ ${x}`));
          failed++;
          continue;
        }
      } catch (err) {
        console.error(`❌ ${file}: ${(err as Error).message}`);
        failed++;
        continue;
      }

      const state = readState(dir, fileName);
      if (!opts.all && state && !locallyModified(dir, spec, file)) {
        unchanged++;
        continue;
      }

      const current = state?.serverPayload;
      let server: Payload | undefined;
      const lookupPayload = current ?? local;
      const getUrl = spec.getPath(lookupPayload, config);
      if (getUrl) {
        const get = await api<Payload>(config, "GET", getUrl);
        if (get.status === 200) server = get.data;
        else if (get.status !== 404) {
          console.error(`❌ ${spec.kind}/${spec.identity(local)} : lecture serveur HTTP ${get.status} ${get.text ?? ""}`);
          failed++;
          continue;
        }
      }

      if (!state) {
        if (!server && spec.naturalIdentity) {
          const listed = await api<Payload[]>(config, "GET", spec.listPath(config));
          if (listed.status === 200 && Array.isArray(listed.data)) {
            const match = listed.data.find(
              (candidate) => spec.naturalIdentity!(candidate) === spec.naturalIdentity!(local)
            );
            if (match) server = await fullPayload(config, spec, match);
          }
        }

        if (server) {
          console.error(`⛔ ${spec.kind}/${spec.identity(local)} : existe déjà sur le serveur mais aucune baseline locale n'est disponible. Relancez pull.`);
          blocked++;
          continue;
        }
        if (opts.dryRun) {
          console.log(`🆕 ${spec.kind}/${spec.identity(local)} serait créé`);
          continue;
        }

        const created = await api<Payload>(config, "POST", spec.createPath(local, config), local);
        if (created.status < 200 || created.status >= 300 || !created.data) {
          console.error(`❌ Création ${spec.kind}/${spec.identity(local)} impossible : HTTP ${created.status} ${created.text ?? ""}`);
          failed++;
          continue;
        }

        const full = await fullPayload(config, spec, created.data);
        const oldFile = file;
        const wanted = path.join(dir, spec.fileName(full));
        if (oldFile !== wanted && !fs.existsSync(wanted)) fs.renameSync(oldFile, wanted);
        writeResource(dir, spec, full);
        console.log(`🆕 ${spec.kind}/${spec.identity(full)} créé et vérifié`);
        pushed++;
        continue;
      }

      if (!server) {
        console.error(`⛔ ${spec.kind}/${spec.identity(local)} : ressource supprimée ou introuvable sur le serveur. Aucune recréation implicite depuis une baseline existante.`);
        blocked++;
        continue;
      }

      if (!sameContent(server, current) && !opts.force) {
        console.error(`⛔ ${spec.kind}/${spec.identity(local)} : serveur modifié depuis le dernier pull. Relancez pull avant push ou utilisez --force.`);
        blocked++;
        continue;
      }

      if (opts.dryRun) {
        console.log(`🔎 ${spec.kind}/${spec.identity(local)} serait mis à jour`);
        continue;
      }

      const updateUrl = spec.updatePath(server, config);
      if (!updateUrl) {
        console.error(`❌ ${spec.kind}/${spec.identity(local)} : identifiant serveur insuffisant pour PUT`);
        failed++;
        continue;
      }

      const updatePayload = { ...local };
      // IDs sont gérés par les paths pour labels/datalib et ne sont pas requis dans le body.
      const updated = await api<Payload>(config, "PUT", updateUrl, updatePayload);
      if (updated.status < 200 || updated.status >= 300 || !updated.data) {
        console.error(`❌ Mise à jour ${spec.kind}/${spec.identity(local)} impossible : HTTP ${updated.status} ${updated.text ?? ""}`);
        failed++;
        continue;
      }

      const full = await fullPayload(config, spec, updated.data);
      if (!sameContent(spec.editable(full), spec.editable({ ...full, ...local }))) {
        console.error(`❌ ${spec.kind}/${spec.identity(local)} : contenu différent après relecture serveur`);
        failed++;
        continue;
      }
      writeResource(dir, spec, full);
      console.log(`⬆️ ${spec.kind}/${spec.identity(full)} mis à jour et vérifié`);
      pushed++;
    }
  }

  console.log(`📦 Ressources : ${pushed} poussée(s), ${unchanged} inchangée(s), ${blocked} bloquée(s), ${failed} erreur(s).`);
  return blocked || failed ? 1 : 0;
}
