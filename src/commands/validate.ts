import { loadConfig, testsDir } from "../config.js";
import { findLocalTestDirs, readLocalTest } from "../dsl/local-format.js";
import { validateResources } from "../resources.js";

export async function validateCommand(): Promise<void> {
  const config = loadConfig();
  const testDirs = findLocalTestDirs(testsDir(config));

  let errors = 0;

  for (const testDir of testDirs) {
    try {
      const { data, issues } = readLocalTest(testDir);

      if (issues.length === 0) {
        console.log(`✅ ${data.testFolderId}/${data.testcaseId}`);
        continue;
      }

      errors += issues.length;
      console.error(`❌ ${data.testFolderId}/${data.testcaseId}`);
      for (const issue of issues) {
        console.error(`   ${issue.file}${issue.line ? `:${issue.line}` : ""} - ${issue.message}`);
      }
    } catch (err) {
      errors++;
      console.error(`❌ ${testDir} - ${(err as Error).message}`);
    }
  }

  const resourceIssues = validateResources(config);
  for (const issue of resourceIssues) {
    console.error(`❌ ${issue}`);
  }
  errors += resourceIssues.length;

  if (errors > 0) {
    throw new Error(`${errors} erreur(s) de validation.`);
  }

  console.log(`\n✅ Validation terminée : ${testDirs.length} testcase(s) + ressources workspace valides.`);
}
