import { TestCase } from "./types.js";
import { loadConfig } from "./config.js";

export class CerberusClient {
    constructor(private cfg = loadConfig()) {}

    private async headers(extra: Record<string, string> = {}): Promise<Record<string, string>> {
        return {
            accept: "application/json",
            ...(await this.cfg.authHeaders()),
            "X-API-VERSION": this.cfg.apiVersion,
            ...extra,
        };
    }

    async getTests(folder: string): Promise<TestCase[]> {
        const url = `${this.cfg.apiUrl}/testcases/${encodeURIComponent(folder)}`;
        const res = await fetch(url, { method: "GET", headers: await this.headers() });
        if (!res.ok) throw new Error(`Erreur API ${res.status} - ${await res.text()}`);
        return (await res.json()) as TestCase[];
    }

    async updateTest(test: TestCase): Promise<TestCase> {
        const url = `${this.cfg.apiUrl}/testcases/${encodeURIComponent(test.testFolderId)}/${encodeURIComponent(test.testcaseId)}`;
        const res = await fetch(url, {
            method: "PUT",
            headers: await this.headers({ "Content-Type": "application/json" }),
            body: JSON.stringify(test),
        });
        if (!res.ok) throw new Error(`Erreur API ${res.status} - ${await res.text()}`);
        return (await res.json()) as TestCase;
    }
}
