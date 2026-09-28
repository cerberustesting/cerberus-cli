import readline from "readline";
import { saveApiKey } from "../config.js";

function promptHidden(question: string): Promise<string> {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        const out = rl as unknown as { _writeToOutput: (s: string) => void };
        process.stdout.write(question);
        out._writeToOutput = () => {};
        rl.question("", (answer) => {
            rl.close();
            process.stdout.write("\n");
            resolve(answer.trim());
        });
    });
}

export async function loginCommand(apiKeyArg?: string) {
    const apiKey = apiKeyArg ?? (await promptHidden("Clé API Cerberus : "));
    if (!apiKey) throw new Error("Clé API vide.");
    const file = saveApiKey(apiKey);
    console.log(`✅ Clé enregistrée dans ${file} (mode 600)`);
}
