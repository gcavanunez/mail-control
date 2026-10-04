import { GmailError, type GmailLabel, GmailScopeError } from "@mail-control/gmail"
import { Effect } from "effect"
import { describe, expect, it, vi } from "vitest"
import {
  buildFilterRequest,
  type FilterOptions,
  missingFilterScopeMessage,
  resolveLabel,
  SPAM_UNSUPPORTED_MESSAGE,
  toFilterError,
} from "../src/filters.js"

const options = (overrides: Partial<FilterOptions>): FilterOptions => ({
  skipInbox: false,
  markRead: false,
  trash: false,
  spam: false,
  neverSpam: false,
  ...overrides,
})

describe("buildFilterRequest", () => {
  it("maps criteria and archive/read actions to a Gmail filter body", async () => {
    const request = await Effect.runPromise(
      buildFilterRequest(
        options({ from: "notifications@stripe.com", subject: '"test mode"', skipInbox: true, markRead: true }),
      ),
    )

    expect(request).toEqual({
      criteria: { from: "notifications@stripe.com", subject: '"test mode"' },
      action: { removeLabelIds: ["INBOX", "UNREAD"] },
    })
  })

  it("maps every criterion and action flag", async () => {
    const request = await Effect.runPromise(
      buildFilterRequest(
        options({
          from: "a@x.com",
          to: "me@x.com",
          subject: "invoice",
          query: "has:attachment",
          hasWords: "receipt",
          negatedQuery: "urgent",
          label: "Receipts",
          trash: true,
          neverSpam: true,
        }),
        "Label_7",
      ),
    )

    expect(request).toEqual({
      criteria: {
        from: "a@x.com",
        to: "me@x.com",
        subject: "invoice",
        query: "has:attachment receipt",
        negatedQuery: "urgent",
      },
      action: { addLabelIds: ["Label_7", "TRASH"], removeLabelIds: ["SPAM"] },
    })
  })

  it("rejects --spam because Gmail filters cannot add SPAM", async () => {
    const error = await Effect.runPromise(Effect.flip(buildFilterRequest(options({ from: "a@x.com", spam: true }))))
    expect(error.message).toBe(SPAM_UNSUPPORTED_MESSAGE)
  })

  it("requires a criterion and an action", async () => {
    const noCriteria = await Effect.runPromise(Effect.flip(buildFilterRequest(options({ skipInbox: true }))))
    expect(noCriteria.message).toMatch(/at least one criterion/)

    const noAction = await Effect.runPromise(Effect.flip(buildFilterRequest(options({ from: "a@x.com" }))))
    expect(noAction.message).toMatch(/at least one action/)
  })
})

describe("filter scope errors", () => {
  it("tells the user exactly how to re-authorize", () => {
    const error = toFilterError("anomaly")(
      new GmailScopeError({
        message: "Gmail token is missing a scope",
        scope: "https://www.googleapis.com/auth/gmail.settings.basic",
      }),
    )

    expect(error.message).toBe(missingFilterScopeMessage("anomaly"))
    expect(error.message).toContain("https://www.googleapis.com/auth/gmail.settings.basic")
    expect(error.message).toContain("mail auth anomaly")
  })

  it("keeps the API reason for other failures", () => {
    const error = toFilterError("anomaly")(
      new GmailError({ message: "Failed to create Gmail filter", cause: new Error("Filter already exists") }),
    )

    expect(error.message).toBe("Failed to create Gmail filter: Filter already exists")
  })
})

describe("resolveLabel", () => {
  const labels: GmailLabel[] = [
    { id: "INBOX", name: "INBOX", type: "system" },
    { id: "Label_1", name: "Stripe", type: "user" },
    { id: "Label_2", name: "Receipts", type: "user" },
  ]
  const makeGmail = () => {
    let next = 10
    return {
      listLabels: vi.fn(() => Effect.succeed([...labels])),
      createLabel: vi.fn((name: string) => Effect.succeed({ id: `Label_${next++}`, name, type: "user" })),
    }
  }

  it("resolves an existing label case-insensitively without creating", async () => {
    const gmail = makeGmail()
    const label = await Effect.runPromise(resolveLabel(gmail, "receipts", { create: true }))

    expect(label).toEqual({ name: "Receipts", id: "Label_2", created: false })
    expect(gmail.createLabel).not.toHaveBeenCalled()
  })

  it("creates a missing nested label, creating missing parents first", async () => {
    const gmail = makeGmail()
    const label = await Effect.runPromise(resolveLabel(gmail, "Alerts/Stripe/test-mode", { create: true }))

    expect(gmail.createLabel.mock.calls.map(([name]) => name)).toEqual([
      "Alerts",
      "Alerts/Stripe",
      "Alerts/Stripe/test-mode",
    ])
    expect(label).toEqual({ name: "Alerts/Stripe/test-mode", id: "Label_12", created: true })
  })

  it("reuses an existing parent", async () => {
    const gmail = makeGmail()
    await Effect.runPromise(resolveLabel(gmail, "Stripe/test-mode", { create: true }))

    expect(gmail.createLabel.mock.calls.map(([name]) => name)).toEqual(["Stripe/test-mode"])
  })

  it("does not create labels on a dry run", async () => {
    const gmail = makeGmail()
    const label = await Effect.runPromise(resolveLabel(gmail, "Stripe/test-mode", { create: false }))

    expect(label).toEqual({ name: "Stripe/test-mode", created: false })
    expect(gmail.createLabel).not.toHaveBeenCalled()
  })
})
