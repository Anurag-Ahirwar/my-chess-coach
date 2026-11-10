import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { AppDatabase } from "@/infra/storage/db";

let counter = 0;

/** A fresh IndexedDB (fake-indexeddb, test only) per call, or the named one to "reopen" it. */
export function testDatabase(name = `test-db-${Date.now()}-${++counter}`): AppDatabase {
  return new AppDatabase(name, { indexedDB, IDBKeyRange });
}
