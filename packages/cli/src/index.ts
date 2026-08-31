/**
 * @packageDocumentation
 * Unified mail CLI for Gmail API, Gmail IMAP/SMTP, and iCloud built on Effect.
 */

export { program as mailCliProgram } from "./cli.js"
export {
  type AccountConfig,
  type AccountId,
  Accounts,
  type AccountType,
  type GmailImapAccountConfig,
  layer as accountsLayer,
  type MailConfigFile,
  type ResolvedAccount,
} from "./config.js"
export { gmailImapSearchCriteria, makeGmailImapMailService } from "./gmail-imap.js"
export { makeICloudService } from "./icloud.js"
export { layer as secretsLayer, Secrets } from "./secrets.js"
export { MailService, makeGmailMailService, makeICloudMailService } from "./service.js"
export {
  type ListMailOptions,
  MailConfigError,
  MailError,
  type MailMessageBody,
  type MailMessageSummary,
  type MailStatus,
  type ReadMailInput,
  type SendMailInput,
} from "./types.js"
