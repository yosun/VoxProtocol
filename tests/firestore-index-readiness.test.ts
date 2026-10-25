import {describe, expect, it} from "vitest";
import {missingReadyIndexes} from "../scripts/check-firestore-indexes.mjs";

const expected = {collectionGroup: "vox_nft_mints", queryScope: "COLLECTION", fields: [{fieldPath: "state", order: "ASCENDING"}, {fieldPath: "updated_at", order: "ASCENDING"}]};
const actual = {name: "projects/voxprotocol/databases/(default)/collectionGroups/vox_nft_mints/indexes/example", state: "READY", queryScope: "COLLECTION", fields: [...expected.fields, {fieldPath: "__name__", order: "ASCENDING"}]};

describe("production database index readiness", () => {
  it("accepts READY indexes with Firestore's implicit document-name field", () => {
    expect(missingReadyIndexes([expected], [actual])).toEqual([]);
  });
  it("blocks missing, building, wrong-scope, and incorrectly ordered indexes", () => {
    for (const indexes of [[], [{...actual, state: "CREATING"}], [{...actual, queryScope: "COLLECTION_GROUP"}], [{...actual, fields: [...expected.fields].reverse()}]]) {
      expect(missingReadyIndexes([expected], indexes)).toEqual([expected]);
    }
  });
});
