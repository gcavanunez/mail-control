import { parseListUnsubscribe } from "@mail-control/gmail"
import { Effect, Redacted } from "effect"
import { ImapFlow, type SearchObject } from "imapflow"
import { type ParsedMail, simpleParser } from "mailparser"
import nodemailer from "nodemailer"
import type { AccountId, GmailImapAccountConfig } from "./config.js"
import { type MailError, mailError } from "./errors.js"
import { findUnsubscribeUrl, parseRawHeaders } from "./icloud.js"
import { fetchExternalHttps } from "./safe-http.js"
import { type DownloadedAttachment, MailService } from "./service.js"
import type {
  Attachment,
  ListMailOptions,
  Mailbox,
  MailMessageBody,
  MailMessageSummary,
  ReadMailInput,
  ReplyMailInput,
  SendMailInput,
} from "./types.js"

interface GmailImapConnection {
  readonly email: string
  readonly password: Redacted.Redacted<string>
  readonly mailbox: string
  readonly imap: { readonly host: string; readonly port: number; readonly secure: boolean }
  readonly smtp: {
    readonly enabled: boolean
    readonly host: string
    readonly port: number
    readonly secure: boolean
  }
}

interface GmailImapMessageReference {
  readonly version: 1
  readonly emailId: string
}

const MESSAGE_ID_PREFIX = "gmi1."

export const encodeGmailImapMessageId = (emailId: string): string =>
  `${MESSAGE_ID_PREFIX}${Buffer.from(JSON.stringify({ version: 1, emailId })).toString("base64url")}`

export const decodeGmailImapMessageId = (value: string): GmailImapMessageReference | undefined => {
  if (!value.startsWith(MESSAGE_ID_PREFIX)) return undefined
  try {
    const parsed = JSON.parse(Buffer.from(value.slice(MESSAGE_ID_PREFIX.length), "base64url").toString("utf8")) as {
      version?: unknown
      emailId?: unknown
    }
    return parsed.version === 1 && typeof parsed.emailId === "string" && parsed.emailId.length > 0
      ? { version: 1, emailId: parsed.emailId }
      : undefined
  } catch {
    return undefined
  }
}

const requireMessageReference = (value: string): GmailImapMessageReference => {
  const reference = decodeGmailImapMessageId(value)
  if (!reference) throw new Error(`Invalid Gmail IMAP message ID: ${value}`)
  return reference
}

const connectionFrom = (account: GmailImapAccountConfig, password: Redacted.Redacted<string>): GmailImapConnection => ({
  email: account.email,
  password: Redacted.make(Redacted.value(password).replaceAll(" ", "")),
  mailbox: account.mailbox ?? "INBOX",
  imap: {
    host: account.imapHost ?? "imap.gmail.com",
    port: account.imapPort ?? 993,
    secure: account.imapSecure ?? true,
  },
  smtp: {
    enabled: account.smtpEnabled ?? false,
    host: account.smtpHost ?? "smtp.gmail.com",
    port: account.smtpPort ?? 465,
    secure: account.smtpSecure ?? true,
  },
})

export const gmailImapSearchCriteria = (options?: ListMailOptions): SearchObject => {
  const criteria: SearchObject = options?.query ? { gmraw: options.query } : { all: true }
  if (options?.status === "unread") criteria.seen = false
  if (options?.status === "read") criteria.seen = true
  return criteria
}

const formatAddress = (name?: string, address?: string) => {
  if (!address) return name ?? ""
  return name ? `${name} <${address}>` : address
}

const summaryFrom = (
  account: AccountId,
  message: {
    uid: number
    emailId?: string
    envelope?: { subject?: string; from?: { name?: string; address?: string }[]; date?: Date }
    flags?: Set<string>
  },
): MailMessageSummary => {
  if (!message.emailId) throw new Error("Gmail IMAP did not return X-GM-MSGID for a listed message")
  const from = message.envelope?.from?.[0]
  return {
    account,
    id: encodeGmailImapMessageId(message.emailId),
    subject: message.envelope?.subject ?? "(no subject)",
    from: formatAddress(from?.name, from?.address),
    ...(message.envelope?.date ? { date: message.envelope.date.toISOString() } : {}),
    ...(message.flags ? { unread: !message.flags.has("\\Seen") } : {}),
  }
}

const attachmentMeta = (parsed: ParsedMail) =>
  parsed.attachments.map((attachment, index) => ({
    id: String(index),
    filename: attachment.filename ?? `attachment-${index + 1}`,
    mimeType: attachment.contentType || "application/octet-stream",
    size: attachment.size ?? attachment.content.length,
  }))

const bodyFrom = (id: string, parsed: ParsedMail, unread?: boolean): MailMessageBody => ({
  id,
  subject: parsed.subject ?? "(no subject)",
  from: parsed.from?.text ?? "",
  ...(parsed.date ? { date: parsed.date.toISOString() } : {}),
  body: parsed.text ?? "",
  ...(typeof parsed.html === "string" ? { htmlBody: parsed.html } : {}),
  ...(unread !== undefined ? { unread } : {}),
  ...(parsed.attachments.length > 0 ? { attachments: attachmentMeta(parsed) } : {}),
})

const toMailerAttachment = (attachment: Attachment) => ({
  filename: attachment.filename,
  content: Buffer.isBuffer(attachment.content) ? attachment.content : Buffer.from(attachment.content),
  contentType: attachment.mimeType,
})

const referencesFrom = (parsed: ParsedMail): string[] => {
  const references =
    parsed.references === undefined ? [] : Array.isArray(parsed.references) ? parsed.references : [parsed.references]
  return parsed.messageId ? [...references, parsed.messageId] : references
}

/** Gmail IMAP exposes X-GM-MSGID as emailId, which remains stable across labels. */
const resolveUid = async (client: ImapFlow, messageId: string): Promise<number | undefined> => {
  const matches = await client.search({ emailId: messageId }, { uid: true })
  return Array.isArray(matches) ? matches[0] : undefined
}

const mailboxWith = async (client: ImapFlow, specialUse: string, fallback: string) =>
  (await client.list()).find((mailbox) => mailbox.specialUse === specialUse)?.path ?? fallback

export const makeGmailImapMailService = (
  accountId: AccountId,
  account: GmailImapAccountConfig,
  password: Redacted.Redacted<string>,
): MailService["Service"] => {
  const config = connectionFrom(account, password)

  const withClient = <A>(label: string, use: (client: ImapFlow) => Promise<A>): Effect.Effect<A, MailError> =>
    Effect.acquireUseRelease(
      Effect.tryPromise({
        try: async () => {
          const client = new ImapFlow({
            host: config.imap.host,
            port: config.imap.port,
            secure: config.imap.secure,
            logger: false,
            auth: { user: config.email, pass: Redacted.value(config.password) },
          })
          await client.connect()
          if (!client.capabilities.has("X-GM-EXT-1")) {
            throw new Error("The IMAP server does not advertise Gmail X-GM-EXT-1 support")
          }
          return client
        },
        catch: mailError("Failed to connect to Gmail IMAP"),
      }),
      (client) => Effect.tryPromise({ try: () => use(client), catch: mailError(label) }),
      (client) => Effect.promise(() => client.logout()).pipe(Effect.ignore),
    )

  const allMail = (client: ImapFlow) => mailboxWith(client, "\\All", "[Gmail]/All Mail")
  const trash = (client: ImapFlow) => mailboxWith(client, "\\Trash", "[Gmail]/Trash")

  const locateMessage = async (client: ImapFlow, emailId: string, preferredMailbox?: string) => {
    const mailboxes = (await client.list()).filter((mailbox) => !mailbox.flags.has("\\Noselect"))
    const priority = new Map([
      ["\\All", 0],
      ["\\Trash", 1],
      ["\\Junk", 2],
      ["\\Drafts", 3],
      ["\\Sent", 4],
      ["\\Inbox", 5],
    ])
    const ordered = [...mailboxes].sort((left, right) => {
      if (left.path === preferredMailbox) return -1
      if (right.path === preferredMailbox) return 1
      return (priority.get(left.specialUse ?? "") ?? 10) - (priority.get(right.specialUse ?? "") ?? 10)
    })

    for (const mailbox of ordered) {
      await client.mailboxOpen(mailbox.path)
      const uid = await resolveUid(client, emailId)
      if (uid !== undefined) return { mailbox: mailbox.path, uid }
    }
    throw new Error(`No Gmail IMAP message ${emailId} found in any mailbox`)
  }

  const fetchParsed = async (client: ImapFlow, messageId: string, mailboxOverride?: string) => {
    const reference = requireMessageReference(messageId)
    const located = await locateMessage(client, reference.emailId, mailboxOverride)
    const message = await client.fetchOne(located.uid, { source: true, flags: true }, { uid: true })
    if (message === false || message.source === undefined) {
      throw new Error(`No Gmail IMAP message ${messageId} found in ${located.mailbox}`)
    }
    return { parsed: await simpleParser(message.source), source: message.source, unread: !message.flags?.has("\\Seen") }
  }

  const smtpTransport = () => {
    if (!config.smtp.enabled) {
      throw new Error(`SMTP is disabled for account "${accountId}"; set "smtpEnabled": true to allow sending.`)
    }
    return nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: { user: config.email, pass: Redacted.value(config.password) },
    })
  }

  const sendSmtp = (input: SendMailInput) =>
    Effect.tryPromise({
      try: async () => {
        await smtpTransport().sendMail({
          from: config.email,
          to: input.to,
          subject: input.subject,
          text: input.body,
          html: input.htmlBody,
          cc: input.cc,
          bcc: input.bcc,
          attachments: input.attachments?.map(toMailerAttachment),
        })
      },
      catch: mailError("Failed to send email via Gmail SMTP"),
    })

  const listMailboxes = () =>
    withClient("Failed to list Gmail IMAP mailboxes", async (client) =>
      (await client.list())
        .filter((mailbox) => !mailbox.flags.has("\\Noselect"))
        .map(
          (mailbox): Mailbox => ({
            account: accountId,
            id: mailbox.path,
            name: mailbox.path,
            kind: "imap",
            ...(mailbox.specialUse ? { specialUse: mailbox.specialUse } : {}),
          }),
        ),
    )

  const listMessages = (options?: ListMailOptions) =>
    withClient("Failed to list Gmail IMAP messages", async (client) => {
      const mailbox = options?.mailbox ?? (options?.inboxOnly === false ? await allMail(client) : config.mailbox)
      await client.mailboxOpen(mailbox)
      const found = await client.search(gmailImapSearchCriteria(options), { uid: true })
      const uids = Array.isArray(found) ? found : []
      const target = uids.slice(-(options?.maxResults ?? 10)).reverse()
      if (target.length === 0) return []

      const byUid = new Map<number, MailMessageSummary>()
      for await (const message of client.fetch(target, { uid: true, envelope: true, flags: true }, { uid: true })) {
        byUid.set(message.uid, summaryFrom(accountId, message))
      }
      return target.flatMap((uid) => {
        const message = byUid.get(uid)
        return message ? [message] : []
      })
    })

  const readMessage = (input: ReadMailInput) =>
    withClient(`Failed to read Gmail IMAP message ${input.id}`, async (client) => {
      const message = await fetchParsed(client, input.id, input.mailbox)
      return bodyFrom(input.id, message.parsed, message.unread)
    })

  const replyToEmail = (input: ReplyMailInput) =>
    withClient(`Failed to retrieve Gmail IMAP message ${input.messageId} for reply`, async (client) => {
      const original = (await fetchParsed(client, input.messageId)).parsed
      const recipient = original.replyTo?.text ?? original.from?.text
      if (!recipient) throw new Error(`Could not determine a reply address for message ${input.messageId}`)
      const subject = original.subject?.toLowerCase().startsWith("re:")
        ? original.subject
        : `Re: ${original.subject ?? ""}`
      await smtpTransport().sendMail({
        from: config.email,
        to: recipient,
        subject,
        text: input.body,
        html: input.htmlBody,
        cc: input.cc,
        bcc: input.bcc,
        inReplyTo: original.messageId,
        references: referencesFrom(original),
        attachments: input.attachments?.map(toMailerAttachment),
      })
    })

  const downloadAttachments = (messageId: string) =>
    withClient(`Failed to download Gmail IMAP attachments for ${messageId}`, async (client) => {
      const parsed = (await fetchParsed(client, messageId)).parsed
      return parsed.attachments.map(
        (attachment, index): DownloadedAttachment => ({
          filename: attachment.filename ?? `attachment-${index + 1}`,
          mimeType: attachment.contentType || "application/octet-stream",
          content: attachment.content,
        }),
      )
    })

  const archiveMessage = (messageId: string) =>
    withClient(`Failed to archive Gmail IMAP message ${messageId}`, async (client) => {
      const reference = requireMessageReference(messageId)
      const located = await locateMessage(client, reference.emailId)
      await client.messageFlagsRemove(located.uid, ["\\Inbox"], { uid: true, useLabels: true })
    })

  const trashMessage = (messageId: string) =>
    withClient(`Failed to trash Gmail IMAP message ${messageId}`, async (client) => {
      const reference = requireMessageReference(messageId)
      const destination = await trash(client)
      const located = await locateMessage(client, reference.emailId)
      if (located.mailbox === destination) return
      await client.messageMove(located.uid, destination, { uid: true })
    })

  const markMessageRead = (messageId: string) =>
    withClient(`Failed to mark Gmail IMAP message ${messageId} read`, async (client) => {
      const reference = requireMessageReference(messageId)
      const located = await locateMessage(client, reference.emailId)
      await client.messageFlagsAdd(located.uid, ["\\Seen"], { uid: true })
    })

  const unsubscribeFromMessage = (messageId: string) =>
    withClient(`Failed to unsubscribe from Gmail IMAP message ${messageId}`, async (client) => {
      const message = await fetchParsed(client, messageId)
      const raw = message.source.toString("utf8")
      const headerEnd = raw.search(/\r?\n\r?\n/)
      const headers = parseRawHeaders(headerEnd === -1 ? raw : raw.slice(0, headerEnd))
      const destinations = parseListUnsubscribe(headers.get("list-unsubscribe") ?? "")
      const httpsDestination = destinations.find((destination) => destination.protocol === "https:")
      const oneClick = headers.get("list-unsubscribe-post")?.toLowerCase().includes("list-unsubscribe=one-click")

      if (oneClick && httpsDestination) {
        const response = await fetchExternalHttps(httpsDestination, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "List-Unsubscribe=One-Click",
        })
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
        return "one-click" as const
      }

      const visitWeb = async (destination: string) => {
        const response = await fetchExternalHttps(destination)
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
        return "web" as const
      }

      const webDestination = httpsDestination?.toString() ?? findUnsubscribeUrl(raw)
      if (webDestination && !config.smtp.enabled) return visitWeb(webDestination)

      const mailtoDestination = destinations.find((destination) => destination.protocol === "mailto:")
      if (mailtoDestination) {
        const to = decodeURIComponent(mailtoDestination.pathname)
        await smtpTransport().sendMail({
          from: config.email,
          to,
          subject: mailtoDestination.searchParams.get("subject") ?? "unsubscribe",
          text: mailtoDestination.searchParams.get("body") ?? "unsubscribe",
        })
        return "mailto" as const
      }

      if (webDestination) return visitWeb(webDestination)

      throw new Error(`Message ${messageId} does not provide an actionable unsubscribe option`)
    })

  return MailService.of({
    listMailboxes,
    listMessages,
    readMessage,
    sendEmail: sendSmtp,
    replyToEmail,
    downloadAttachments,
    archiveMessage,
    trashMessage,
    markMessageRead,
    unsubscribeFromMessage,
  })
}
