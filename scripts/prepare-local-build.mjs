import { copyFile, mkdir } from "node:fs/promises";
import { constants } from "node:fs";

// Local builds need the binding manifest, but must never invent a Site ID or
// overwrite an installation's registered manifest. Sites assigns identity.
await mkdir(".openai", { recursive: true });
try {
  await copyFile(".openai/hosting.template.json", ".openai/hosting.json", constants.COPYFILE_EXCL);
} catch (error) {
  if (error.code !== "EEXIST") throw error;
}
