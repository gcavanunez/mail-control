import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import { writeAppPassword } from "../src/secrets.js"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

describe("app-password storage", () => {
  it("repairs permissions on an existing secrets file", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "mail-control-secrets-"))
    temporaryDirectories.push(directory)
    const filename = path.join(directory, "secrets.json")
    await writeFile(filename, '{"accounts":{}}')
    await chmod(filename, 0o664)

    await Effect.runPromise(writeAppPassword(directory, "field", "secret").pipe(Effect.provide(NodeServices.layer)))

    expect((await stat(filename)).mode & 0o777).toBe(0o600)
  })
})
