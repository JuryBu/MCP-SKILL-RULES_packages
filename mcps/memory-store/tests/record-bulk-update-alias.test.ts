import assert from "node:assert/strict";
import { z } from "zod";
import { isRecordBatchUpdateAction, registerRecord } from "../src/tools/record.js";

type RegisteredTool = {
    name: string;
    description: string;
    schema: Record<string, z.ZodTypeAny>;
};

const registeredTools: RegisteredTool[] = [];
const fakeServer = {
    tool(name: string, description: string, schema: Record<string, z.ZodTypeAny>) {
        registeredTools.push({ name, description, schema });
    },
};

registerRecord(fakeServer as never);

const recordTool = registeredTools.find(tool => tool.name === "record_manage");
assert.ok(recordTool, "record_manage should be registered");

assert.equal(isRecordBatchUpdateAction("batch_update"), true);
assert.equal(isRecordBatchUpdateAction("bulk_update"), true);
assert.equal(isRecordBatchUpdateAction("update"), false);

const actionSchema = recordTool.schema.action;
assert.equal(actionSchema.safeParse("batch_update").success, true);
assert.equal(actionSchema.safeParse("bulk_update").success, true);
assert.equal(actionSchema.safeParse("bulk_delete").success, false);

assert.match(recordTool.description, /bulk_update/);

console.log("✅ record bulk_update alias tests passed");
