import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { MailConfigFile, makeAccountId, type ResolvedAccount } from "../src/config.js"
import { appPasswordEnvVar } from "../src/secrets.js"

describe("Gmail IMAP configuration", () => {
  it("accepts app-password accounts without OAuth files", () => {
    expect(
      Schema.decodeUnknownSync(MailConfigFile)({
        accounts: {
          field: { type: "gmail-imap", email: "swift@example.net", smtpEnabled: false },
        },
      }),
    ).toEqual({
      accounts: {
        field: { type: "gmail-imap", email: "swift@example.net", smtpEnabled: false },
      },
    })
  })

  it("requires an email address", () => {
    expect(() => Schema.decodeUnknownSync(MailConfigFile)({ accounts: { field: { type: "gmail-imap" } } })).toThrow()
  })

  it("honors custom app-password environment variables", () => {
    const account: ResolvedAccount = {
      id: makeAccountId("field-notes"),
      config: { type: "gmail-imap", email: "swift@example.net", appPasswordEnv: "FIELD_MAIL_PASSWORD" },
    }

    expect(appPasswordEnvVar(account)).toBe("FIELD_MAIL_PASSWORD")
  })
})
