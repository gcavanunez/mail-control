import { describe, expect, it, vi } from "vitest"
import { fetchExternalHttps, isPrivateIpAddress } from "../src/safe-http.js"

const publicLookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 as const }])

describe("external HTTPS requests", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "169.254.169.254",
    "::1",
    "fd00::1",
    "fe80::1",
    "::ffff:7f00:1",
  ])("recognizes %s as private", (address) => expect(isPrivateIpAddress(address)).toBe(true))

  it("rejects local addresses without issuing a request", async () => {
    const request = vi.fn()

    await expect(
      fetchExternalHttps("https://127.0.0.1/unsubscribe", {}, { request, lookup: publicLookup }),
    ).rejects.toThrow("private address")
    expect(request).not.toHaveBeenCalled()
  })

  it("validates redirect destinations before following them", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://localhost/internal" } }))

    await expect(
      fetchExternalHttps("https://example.net/unsubscribe", {}, { request, lookup: publicLookup }),
    ).rejects.toThrow("private address")
    expect(request).toHaveBeenCalledWith(
      new URL("https://example.net/unsubscribe"),
      {},
      { address: "93.184.216.34", family: 4 },
    )
  })

  it("rejects plain HTTP URLs", async () => {
    const request = vi.fn()

    await expect(
      fetchExternalHttps("http://example.net/unsubscribe", {}, { request, lookup: publicLookup }),
    ).rejects.toThrow("must use HTTPS")
  })
})
