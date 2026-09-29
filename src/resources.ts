import fs from "fs";
import path from "path";
import ts from "typescript";
import type { CerberusConfig, CerberusWorkspacePaths } from "./config.js";
import { workspacePaths } from "./config.js";
import { sameContent } from "./sync.js";

export type ResourceKind = "applicationObjects" | "services" | "datalib";
type Payload = Record<string, any>;

interface ResourceSpec {
  kind: ResourceKind;
  dir: keyof Pick<CerberusWorkspacePaths, "applicationObjects" | "services" | "datalib">;
  typeName: "CerberusApplicationObject" | "CerberusService" | "CerberusDataLib";
  listPath(config: CerberusConfig): string;
  getPath(payload: Payload, config: CerberusConfig): string | undefined;
  createPath(payload: Payload, config: CerberusConfig): string;
  updatePath(payload: Payload, config: CerberusConfig): string | undefined;
  identity(payload: Payload): string;
  naturalIdentity?(payload: Payload): string;
  fileName(payload: Payload): string;
  editable(payload: Payload): Payload;
  fromLocal?(local: Payload, baseline?: Payload): Payload;
  validate(payload: Payload, file: string): string[];
  hydrateListItem?: boolean;
}

interface ResourceState {
  formatVersion: 2;
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

function compactDataLib(payload: Payload): Payload {
  const type = String(payload.type ?? "").toUpperCase();
  const data: Record<string, unknown> = {};

  for (const item of payload.subData ?? []) {
    const key = String(item.subData ?? "").trim() || "default";
    let value: unknown;
    if (type === "INTERNAL") value = item.value;
    else if (type === "SERVICE") value = item.parsingAnswer;
    else if (type === "DATABASE") value = item.column;
    else if (type === "CSV" || type === "FILE") value = item.columnPosition;
    else value = item.value;

    if (value !== undefined && value !== null && String(value) !== "") {
      data[key] = value;
    }
  }

  const out: Payload = {};
  for (const [key, value] of Object.entries(withoutVolatile(payload, ["subData"]))) {
    if (value === undefined || value === null || value === "" || value === false) continue;
    if (key === "id" || key === "name" || key === "type") {
      out[key] = value;
      continue;
    }
    out[key] = value;
  }
  out.data = data;
  return out;
}

function expandDataLib(local: Payload, baseline?: Payload): Payload {
  const type = String(local.type ?? baseline?.type ?? "").toUpperCase();
  const baselineItems = Array.isArray(baseline?.subData) ? baseline!.subData : [];
  const data = local.data && typeof local.data === "object" && !Array.isArray(local.data)
    ? local.data as Record<string, unknown>
    : {};

  const subData = Object.entries(data).map(([key, value]) => {
    const subName = key === "default" ? "" : key;
    const previous = baselineItems.find((item: any) => String(item.subData ?? "") === subName) ?? {};
    const next: Payload = { ...previous, subData: subName };

    if (type === "INTERNAL") next.value = value;
    else if (type === "SERVICE") next.parsingAnswer = value;
    else if (type === "DATABASE") next.column = value;
    else if (type === "CSV" || type === "FILE") next.columnPosition = value;
    else next.value = value;

    return next;
  });

  const { data: _data, ...rest } = local;
  return {
    ...(baseline ?? {}),
    ...rest,
    subData,
  };
}

const specs: ResourceSpec[] = [
  {
    kind: "applicationObjects",
    dir: "applicationObjects",
    typeName: "CerberusApplicationObject",
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
    fileName: (p) => `${safeName(p.object)}.ts`,
    editable: (p) => withoutVolatile(p, ["id"]),
    validate: (p, file) => required(p, file, ["application", "object", "value"]),
  },
  {
    kind: "services",
    dir: "services",
    typeName: "CerberusService",
    listPath: (c) => `/services${c.application ? `?application=${encodeURIComponent(c.application)}` : ""}`,
    getPath: (p) => (p.service ? `/services/${encodeURIComponent(p.service)}` : undefined),
    createPath: () => "/services",
    updatePath: (p) => (p.service ? `/services/${encodeURIComponent(p.service)}` : undefined),
    identity: (p) => String(p.service ?? ""),
    fileName: (p) => `${safeName(p.service)}.ts`,
    editable: (p) => withoutVolatile(p),
    validate: (p, file) => required(p, file, ["service", "type", "method"]),
    hydrateListItem: true,
  },
  {
    kind: "datalib",
    dir: "datalib",
    typeName: "CerberusDataLib",
    listPath: (c) => {
      const system = c.system as string | undefined;
      return `/datalibs${system ? `?system=${encodeURIComponent(system)}` : ""}`;
    },
    getPath: (p) => (p.id !== undefined && p.id !== null ? `/datalibs/${encodeURIComponent(p.id)}` : undefined),
    createPath: () => "/datalibs",
    updatePath: (p) => (p.id !== undefined && p.id !== null ? `/datalibs/${encodeURIComponent(p.id)}` : undefined),
    identity: (p) => p.id != null ? String(p.id) : `${p.name ?? ""}|${p.system ?? ""}|${p.environment ?? ""}|${p.country ?? ""}`,
    naturalIdentity: (p) => `${p.name ?? ""}|${p.system ?? ""}|${p.environment ?? ""}|${p.country ?? ""}|${p.type ?? ""}`,
    fileName: (p) => p.id != null ? `${p.id} - ${safeName(p.name)}.ts` : `${safeName(p.name)}.ts`,
    editable: (p) => compactDataLib(p),
    fromLocal: (local, baseline) => expandDataLib(local, baseline),
    validate: (p, file) => required(p, file, ["name", "type"]),
    hydrateListItem: true,
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
  return path.join(dir, ".cerberus", fileName.replace(/\.(?:ts|ya?ml)$/i, ".json"));
}

function sourceText(spec: ResourceSpec, payload: Payload): string {
  return [
    "// Synchronized by Cerberus CLI. Edit this object, then run 'cerberus validate' and 'cerberus push'.",
    `export default ${JSON.stringify(spec.editable(payload), null, 2)} satisfies ${spec.typeName};`,
    "",
  ].join("\n");
}

function writeState(dir: string, fileName: string, payload: Payload): void {
  const state: ResourceState = { formatVersion: 2, serverPayload: payload };
  const stateFile = statePath(dir, fileName);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n", "utf8");
}

function writeResource(dir: string, spec: ResourceSpec, payload: Payload): string {
  fs.mkdirSync(dir, { recursive: true });
  const fileName = spec.fileName(payload);
  const file = path.join(dir, fileName);
  fs.writeFileSync(file, sourceText(spec, payload), "utf8");
  writeState(dir, fileName, payload);
  return file;
}

function readState(dir: string, fileName: string): ResourceState | null {
  try {
    return JSON.parse(fs.readFileSync(statePath(dir, fileName), "utf8")) as ResourceState;
  } catch {
    return null;
  }
}

function parseTsLiteral(node: ts.Expression): unknown {
  if (ts.isParenthesizedExpression(node)) return parseTsLiteral(node.expression);
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return parseTsLiteral(node.expression);
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) {
    return -Number(node.operand.text);
  }
  if (ts.isArrayLiteralExpression(node)) return node.elements.map((e) => parseTsLiteral(e as ts.Expression));
  if (ts.isObjectLiteralExpression(node)) {
    const out: Record<string, unknown> = {};
    for (const prop of node.properties) {
      if (!ts.isPropertyAssignment(prop)) throw new Error("Only plain object properties are supported.");
      const key = ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name) || ts.isNumericLiteral(prop.name)
        ? prop.name.text
        : undefined;
      if (!key) throw new Error("Computed property names are not supported.");
      out[key] = parseTsLiteral(prop.initializer);
    }
    return out;
  }
  throw new Error(`Unsupported TypeScript expression: ${node.getText()}`);
}

function readResourceFile(file: string): Payload {
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  for (const statement of source.statements) {
    if (ts.isExportAssignment(statement)) {
      const value = parseTsLiteral(statement.expression);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("default export must be an object literal.");
      }
      return value as Payload;
    }
  }
  throw new Error("Missing 'export default { ... }'.");
}

function resourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => path.join(dir, e.name));
}

function locallyModified(dir: string, spec: ResourceSpec, file: string): boolean {
  const state = readState(dir, path.basename(file));
  if (!state) return true;
  try {
    const local = readResourceFile(file);
    const normalized = spec.fromLocal ? spec.fromLocal(local, state.serverPayload) : local;
    return !sameContent(spec.editable(normalized), spec.editable(state.serverPayload));
  } catch {
    return true;
  }
}

function findExistingFile(dir: string, spec: ResourceSpec, payload: Payload): string | undefined {
  const wanted = spec.identity(payload);
  for (const file of resourceFiles(dir)) {
    try {
      const state = readState(dir, path.basename(file));
      const candidate = state?.serverPayload ?? readResourceFile(file);
      if (spec.identity(candidate) === wanted) return file;
    } catch {
      // malformed resource is reported by validate
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

async function pullLabelCatalog(config: CerberusConfig, paths: CerberusWorkspacePaths): Promise<void> {
  const query = config.system ? `?system=${encodeURIComponent(config.system)}` : "";
  const list = await api<Payload[]>(config, "GET", `/labels${query}`);
  if (list.status !== 200 || !Array.isArray(list.data)) {
    throw new Error(`Pull labels impossible : HTTP ${list.status} ${list.text ?? ""}`);
  }
  fs.mkdirSync(paths.internal, { recursive: true });
  fs.writeFileSync(
    path.join(paths.internal, "labels.json"),
    JSON.stringify({ formatVersion: 1, labels: list.data }, null, 2) + "\n",
    "utf8"
  );
  console.log(`🏷️ labels : ${list.data.length} disponibles dans le catalogue IDE/CLI`);
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
          path.join(conflictDir, spec.fileName(payload).replace(/\.ts$/i, ".server.json")),
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

  await pullLabelCatalog(config, paths);
}

export function validateResources(config: CerberusConfig): string[] {
  const paths = workspacePaths(config);
  const issues: string[] = [];

  for (const spec of specs) {
    const dir = resourceDir(paths, spec);
    for (const file of resourceFiles(dir)) {
      try {
        const payload = readResourceFile(file);
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
    for (const file of resourceFiles(dir)) {
      const fileName = path.basename(file);
      let local: Payload;
      try {
        local = readResourceFile(file);
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
      local = spec.fromLocal ? spec.fromLocal(local, current) : local;
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

      const updated = await api<Payload>(config, "PUT", updateUrl, local);
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

export function readLabelCatalog(workspaceRoot: string): Payload[] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(workspaceRoot, ".cerberus", "labels.json"), "utf8"));
    return Array.isArray(raw.labels) ? raw.labels : [];
  } catch {
    return [];
  }
}
