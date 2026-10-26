import {execFileSync} from "node:child_process";
import {readFileSync} from "node:fs";
import {pathToFileURL} from "node:url";

export function matchingIndex(wanted, index) {
  const fields = (index) => index.fields.filter((field) => field.fieldPath !== "__name__").map((field) => [field.fieldPath, field.order ?? field.arrayConfig]);
  return index.queryScope === wanted.queryScope &&
    (index.collectionGroup ?? index.name?.match(/collectionGroups\/([^/]+)/)?.[1]) === wanted.collectionGroup &&
    JSON.stringify(fields(index)) === JSON.stringify(fields(wanted));
}

export function missingReadyIndexes(expected, actual) {
  return expected.filter((wanted) => !actual.some((index) => index.state === "READY" && matchingIndex(wanted, index)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const expected = JSON.parse(readFileSync(new URL("../infrastructure/gcp/firestore.indexes.json", import.meta.url), "utf8")).indexes;
  const actual = JSON.parse(execFileSync("gcloud", ["firestore", "indexes", "composite", "list", "--database=(default)", "--project=voxprotocol", "--format=json"], {encoding: "utf8"}));
  const missing = missingReadyIndexes(expected, actual);
  if (missing.length) {
    console.error("Production release paused: required Firestore indexes must be provisioned through the protected infrastructure process and reach READY before API/job promotion.");
    console.error(JSON.stringify(missing));
    process.exitCode = 2;
  } else console.log("Required production Firestore indexes are READY.");
}
