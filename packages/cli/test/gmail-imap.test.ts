import { Effect, Redacted } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { supportsCapability } from "../src/account.js"
import { makeAccountId, type ResolvedAccount } from "../src/config.js"
import {
  decodeGmailImapMessageId,
  encodeGmailImapMessageId,
  gmailImapSearchCriteria,
  makeGmailImapMailService,
} from "../src/gmail-imap.js"

const http = vi.hoisted(() => ({
  fetchExternalHttps: vi.fn(async () => new Response(null, { status: 200 })),
}))

const state = vi.hoisted(() => {
  const sendMail = vi.fn(async () => ({ messageId: "sent-1" }))
  const connection = { mailbox: "" }
  const mailboxOpen = vi.fn(async (mailbox: string) => {
    connection.mailbox = mailbox
  })
  const messageMove = vi.fn(async () => ({}))
  const messageFlagsAdd = vi.fn(async () => true)
  const messageFlagsRemove = vi.fn(async () => true)
  const source = Buffer.from(
    [
      "From: Night Owl <owl@example.net>",
      "To: Swift <swift@example.net>",
      "Subject: Field notes",
      "Message-ID: <message@example.net>",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="test-boundary"',
      "",
      "--test-boundary",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Two owls by the river.",
      "--test-boundary",
      'Content-Type: text/plain; name="notes.txt"',
      'Content-Disposition: attachment; filename="notes.txt"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("attachment body").toString("base64"),
      "--test-boundary--",
      "",
    ].join("\r\n"),
  )
  const client = {
    capabilities: new Map([["X-GM-EXT-1", true]]),
    connect: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    list: vi.fn(async () => [
      { path: "INBOX", specialUse: "\\Inbox", flags: new Set<string>() },
      { path: "[Gmail]/All Mail", specialUse: "\\All", flags: new Set<string>() },
      { path: "[Gmail]/Trash", specialUse: "\\Trash", flags: new Set<string>() },
      { path: "birdwatching", flags: new Set<string>() },
    ]),
    mailboxOpen,
    search: vi.fn(async (criteria: { emailId?: string }) => (criteria.emailId ? [42] : [41, 42])),
    fetch: async function* (uids: number[]) {
      for (const uid of [...uids].reverse()) {
        yield {
          uid,
          emailId: `gmail-${uid}`,
          envelope: {
            subject: `Message ${uid}`,
            from: [{ name: "Night Owl", address: "owl@example.net" }],
            date: new Date(`2026-08-${uid - 20}T12:00:00Z`),
          },
          flags: new Set(uid === 41 ? ["\\Seen"] : []),
        }
      }
    },
    fetchOne: vi.fn(async () => ({ uid: 42, source, flags: new Set<string>() })),
    messageMove,
    messageFlagsAdd,
    messageFlagsRemove,
  }
  return { client, connection, mailboxOpen, messageFlagsAdd, messageFlagsRemove, messageMove, sendMail }
})

vi.mock("imapflow", () => ({
  ImapFlow: vi.fn(function ImapFlow() {
    return state.client
  }),
}))
vi.mock("nodemailer", () => ({ default: { createTransport: vi.fn(() => ({ sendMail: state.sendMail })) } }))
vi.mock("../src/safe-http.js", () => http)

const account = (smtpEnabled = false): ResolvedAccount => ({
  id: makeAccountId("field-notes"),
  config: { type: "gmail-imap", email: "swift@example.net", smtpEnabled },
})

const service = (smtpEnabled = false) =>
  makeGmailImapMailService(
    account().id,
    { ...account(smtpEnabled).config, type: "gmail-imap" },
    Redacted.make("abcd efgh"),
  )
const messageId = encodeGmailImapMessageId("gmail-42")

beforeEach(() => {
  vi.clearAllMocks()
  state.connection.mailbox = ""
  state.client.search.mockImplementation(async (criteria: { emailId?: string }) => (criteria.emailId ? [42] : [41, 42]))
})
afterEach(() => vi.restoreAllMocks())

describe("Gmail IMAP search", () => {
  it("preserves 64-bit Gmail message IDs without mailbox-specific data", () => {
    const encoded = encodeGmailImapMessageId("18446744073709551615")

    expect(decodeGmailImapMessageId(encoded)).toEqual({
      version: 1,
      emailId: "18446744073709551615",
    })
  })

  it("combines Gmail raw queries with IMAP seen state", () => {
    expect(gmailImapSearchCriteria({ query: "from:owl newer_than:2d", status: "unread" })).toEqual({
      gmraw: "from:owl newer_than:2d",
      seen: false,
    })
  })

  it("returns stable Gmail message IDs in requested order", async () => {
    const messages = await Effect.runPromise(service().listMessages({ inboxOnly: false, maxResults: 2 }))

    expect(state.mailboxOpen).toHaveBeenCalledWith("[Gmail]/All Mail")
    expect(messages.map((message) => decodeGmailImapMessageId(message.id)?.emailId)).toEqual(["gmail-42", "gmail-41"])
  })
})

describe("Gmail IMAP messages", () => {
  it("parses MIME bodies and attachment metadata", async () => {
    const message = await Effect.runPromise(service().readMessage({ id: messageId }))

    expect(message.body).toContain("Two owls by the river.")
    expect(message.attachments).toEqual([{ id: "0", filename: "notes.txt", mimeType: "text/plain", size: 15 }])
  })

  it("downloads parsed attachment contents", async () => {
    const attachments = await Effect.runPromise(service().downloadAttachments(messageId))

    expect(attachments[0]?.filename).toBe("notes.txt")
    expect(attachments[0]?.content.toString()).toBe("attachment body")
  })

  it("uses Gmail special-use mailboxes for mutations", async () => {
    const mail = service()
    await Effect.runPromise(mail.archiveMessage(messageId))
    await Effect.runPromise(mail.trashMessage(messageId))
    await Effect.runPromise(mail.markMessageRead(messageId))

    expect(state.messageFlagsRemove).toHaveBeenCalledWith(42, ["\\Inbox"], { uid: true, useLabels: true })
    expect(state.messageMove).toHaveBeenCalledWith(42, "[Gmail]/Trash", { uid: true })
    expect(state.messageFlagsAdd).toHaveBeenCalledWith(42, ["\\Seen"], { uid: true })
  })

  it("finds a stable message ID after the message moves to Trash", async () => {
    state.client.search.mockImplementation(async (criteria: { emailId?: string }) =>
      criteria.emailId && state.connection.mailbox === "[Gmail]/Trash" ? [42] : [],
    )

    await Effect.runPromise(service().readMessage({ id: messageId }))
    await Effect.runPromise(service().markMessageRead(messageId))

    expect(state.mailboxOpen).toHaveBeenCalledWith("[Gmail]/Trash")
    expect(state.messageFlagsAdd).toHaveBeenCalledWith(42, ["\\Seen"], { uid: true })
  })

  it("uses an HTTPS unsubscribe when SMTP is disabled", async () => {
    const unsubscribeSource = Buffer.from(
      [
        "From: Night Owl <owl@example.net>",
        "Subject: Updates",
        "List-Unsubscribe: <mailto:leave@example.net>, <https://example.net/unsubscribe>",
        "",
        "Updates",
      ].join("\r\n"),
    )
    state.client.fetchOne.mockResolvedValueOnce({ uid: 42, source: unsubscribeSource, flags: new Set<string>() })
    await expect(Effect.runPromise(service().unsubscribeFromMessage(messageId))).resolves.toBe("web")
    expect(http.fetchExternalHttps).toHaveBeenCalledWith("https://example.net/unsubscribe")
  })
})

describe("Gmail SMTP opt-in", () => {
  it("only advertises send capabilities when SMTP is enabled", () => {
    expect(supportsCapability(account(), "send")).toBe(false)
    expect(supportsCapability(account(true), "send")).toBe(true)
    expect(supportsCapability(account(true), "reply")).toBe(true)
  })

  it("rejects direct sends while SMTP is disabled", async () => {
    await expect(
      Effect.runPromise(service().sendEmail({ to: "owl@example.net", subject: "Notes", body: "Attached." })),
    ).rejects.toThrow("Failed to send email via Gmail SMTP")
  })

  it("sends after SMTP is explicitly enabled", async () => {
    await Effect.runPromise(service(true).sendEmail({ to: "owl@example.net", subject: "Notes", body: "Attached." }))

    expect(state.sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: "owl@example.net", subject: "Notes" }))
  })
})
