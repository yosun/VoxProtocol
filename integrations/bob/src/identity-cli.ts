import {BobPublisher} from "./index.js";

const usage = `Usage:
  npm run bob:identity -- status
  npm run bob:identity -- backup --output /protected/path/bob.identity-backup.json
  npm run bob:identity -- restore --from /protected/path/bob.identity-backup.json

The backup contains only Bob's root identity key and must remain mode 600.`;

function optionValue(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a path\n\n${usage}`);
  return value;
}

try {
  const [command, ...args] = process.argv.slice(2);
  const bob = new BobPublisher();
  if (command === "status") {
    console.log(JSON.stringify(await bob.identityStatus(), null, 2));
  } else if (command === "backup") {
    const destinationPath = optionValue(args, "--output");
    await bob.backupIdentity(destinationPath);
    console.log(`Bob identity backup written to ${destinationPath}`);
  } else if (command === "restore") {
    const sourcePath = optionValue(args, "--from");
    const status = await bob.restoreIdentity(sourcePath);
    console.log(JSON.stringify(status, null, 2));
  } else {
    throw new Error(usage);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
