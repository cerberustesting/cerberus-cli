export interface ExecutionResult {
    testFolderId: string;
    testcaseId: string;
    description?: string;
    country?: string;
    environment?: string;
    controlStatus: string;
    controlMessage?: string;
    durationInMillis: number;
    executionId?: number;
}

export type Verdict = "pass" | "failure" | "error" | "skipped";

/** Statuts Cerberus → verdict. OK/NA passent, KO échoue, FA/CA/PE/QU sont des erreurs, NE est ignoré. */
export function verdictOf(status: string): Verdict {
    switch (status) {
        case "OK":
        case "NA":
            return "pass";
        case "KO":
            return "failure";
        case "NE":
            return "skipped";
        default:
            return "error";
    }
}

function esc(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        // caractères interdits en XML 1.0
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

export function toJUnit(tag: string, results: ExecutionResult[]): string {
    const verdicts = results.map((r) => verdictOf(r.controlStatus));
    const count = (v: Verdict) => verdicts.filter((x) => x === v).length;
    const time = results.reduce((t, r) => t + r.durationInMillis, 0) / 1000;

    const cases = results.map((r, i) => {
        const target = [r.country, r.environment].filter(Boolean).join("/");
        const name = `${r.testcaseId}${target ? ` [${target}]` : ""}${r.description ? ` ${r.description}` : ""}`;
        const msg = esc(r.controlMessage ?? r.controlStatus);
        const body =
            verdicts[i] === "failure"
                ? `<failure message="${msg}" type="${esc(r.controlStatus)}"/>`
                : verdicts[i] === "error"
                  ? `<error message="${msg}" type="${esc(r.controlStatus)}"/>`
                  : verdicts[i] === "skipped"
                    ? `<skipped message="${msg}"/>`
                    : "";
        return `    <testcase classname="${esc(r.testFolderId)}" name="${esc(name)}" time="${(r.durationInMillis / 1000).toFixed(3)}">${body}</testcase>`;
    });

    return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="${esc(tag)}" tests="${results.length}" failures="${count("failure")}" errors="${count("error")}" skipped="${count("skipped")}" time="${time.toFixed(3)}">
${cases.join("\n")}
  </testsuite>
</testsuites>
`;
}
