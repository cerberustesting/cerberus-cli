import fetch from "node-fetch";
import { TestCase } from "./types.js";
import { loadConfig } from "./config.js";

export class CerberusClient {
    private headers: Record<string, string>;

    constructor(private cfg = loadConfig()) {
        const config = this.cfg;
        this.headers = {
            "accept": "application/json",
            "X-API-KEY": config.apiKey,
            "X-API-VERSION": config.apiVersion
        };
    }

    async getTests(folder: string): Promise<TestCase[]> {
        const url = `${this.cfg.apiUrl}/testcases/${folder}`;
        const res = await fetch(url, {
            method: "GET",
            headers: this.headers
        });
        if (!res.ok) throw new Error(`Erreur API ${res.status} - ${await res.text()}`);
        return (await res.json()) as TestCase[];
    }

    async updateTest(test: TestCase): Promise<TestCase> {
        const url = `${this.cfg.apiUrl}/testcases/${test.testcaseId}`;
        const res = await fetch(url, {
            method: "PUT",
            headers: {
                ...this.headers,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(test)
        });
        if (!res.ok) throw new Error(`Erreur API ${res.status} - ${await res.text()}`);
        return (await res.json()) as TestCase;
    }
}
