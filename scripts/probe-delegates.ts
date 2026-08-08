import "dotenv/config";
import { db } from "../lib/db";
const own = Object.keys(db as object);
const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(db));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const isModel = (k: string) => !k.startsWith("$") && !k.startsWith("_") && typeof (db as any)[k]?.findMany === "function";
console.log("own keys that look like models  :", own.filter(isModel).length);
console.log("proto keys that look like models:", proto.filter(isModel).length);
console.log("sample:", [...new Set([...own, ...proto])].filter(isModel).sort().slice(0, 40).join(" "));
