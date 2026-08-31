import { lookup } from "node:dns/promises"
import { request as httpsRequest } from "node:https"
import { isIP } from "node:net"

interface ExternalHttpResponse {
  readonly headers: Headers
  readonly ok: boolean
  readonly status: number
  readonly statusText: string
}

interface ResolvedAddress {
  readonly address: string
  readonly family: 4 | 6
}

interface ExternalHttpDependencies {
  readonly lookup: typeof lookup
  readonly request: (url: URL, init: RequestInit, target: ResolvedAddress) => Promise<ExternalHttpResponse>
}

const normalizedIp = (address: string): string => address.replace(/^\[|\]$/g, "").toLowerCase()

export const isPrivateIpAddress = (address: string): boolean => {
  const normalized = normalizedIp(address)
  if (isIP(normalized) === 4) {
    const [first = 0, second = 0] = normalized.split(".").map(Number)
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 198 && (second === 18 || second === 19)) ||
      first >= 224
    )
  }
  if (isIP(normalized) === 6) {
    const mappedIpv4 = normalized.match(/^(?:0*:)*ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1]
    if (mappedIpv4) return isPrivateIpAddress(mappedIpv4)
    const mappedHex = normalized.match(/^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/)
    if (mappedHex) {
      const high = Number.parseInt(mappedHex[1] ?? "0", 16)
      const low = Number.parseInt(mappedHex[2] ?? "0", 16)
      return isPrivateIpAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)
    }
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized) ||
      normalized.startsWith("ff")
    )
  }
  return true
}

const resolveExternalHttps = async (url: URL, resolve: typeof lookup): Promise<ResolvedAddress> => {
  if (url.protocol !== "https:") throw new Error(`Unsubscribe URL must use HTTPS: ${url}`)
  const hostname = normalizedIp(url.hostname)
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error(`Unsubscribe URL resolves to a private address: ${hostname}`)
  }
  const family = isIP(hostname)
  if (family === 4 || family === 6) {
    if (isPrivateIpAddress(hostname)) throw new Error(`Unsubscribe URL resolves to a private address: ${hostname}`)
    return { address: hostname, family }
  }
  const addresses = await resolve(hostname, { all: true, verbatim: true })
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateIpAddress(address))) {
    throw new Error(`Unsubscribe URL resolves to a private address: ${hostname}`)
  }
  const target = addresses[0]
  if (!target || (target.family !== 4 && target.family !== 6)) {
    throw new Error(`Unsubscribe URL did not resolve to an IP address: ${hostname}`)
  }
  return { address: target.address, family: target.family }
}

const requestPinned = (url: URL, init: RequestInit, target: ResolvedAddress): Promise<ExternalHttpResponse> =>
  new Promise((resolve, reject) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries())
    headers.host = url.host
    const servername = normalizedIp(url.hostname)
    const body = init.body
    if (body !== undefined && body !== null && typeof body !== "string") {
      reject(new Error("Unsupported unsubscribe request body"))
      return
    }
    const request = httpsRequest(
      {
        family: target.family,
        headers,
        hostname: target.address,
        method: init.method ?? "GET",
        path: `${url.pathname}${url.search}`,
        port: url.port === "" ? 443 : Number(url.port),
        servername: isIP(servername) === 0 ? servername : undefined,
      },
      (response) => {
        response.resume()
        const responseHeaders = new Headers()
        for (const [name, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) {
            value.forEach((item) => {
              responseHeaders.append(name, item)
            })
          } else if (value !== undefined) responseHeaders.set(name, value)
        }
        const status = response.statusCode ?? 0
        resolve({
          headers: responseHeaders,
          ok: status >= 200 && status < 300,
          status,
          statusText: response.statusMessage ?? "",
        })
      },
    )
    request.on("error", reject)
    request.end(body)
  })

export const fetchExternalHttps = async (
  input: string | URL,
  init: RequestInit = {},
  dependencies: ExternalHttpDependencies = { lookup, request: requestPinned },
): Promise<ExternalHttpResponse> => {
  let url = new URL(input)
  let request = init
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const target = await resolveExternalHttps(url, dependencies.lookup)
    const response = await dependencies.request(url, request, target)
    if (response.status < 300 || response.status >= 400) return response
    if (redirects === 5) throw new Error("Unsubscribe URL exceeded the redirect limit")
    const location = response.headers.get("location")
    if (!location) throw new Error(`Unsubscribe URL returned HTTP ${response.status} without a Location header`)
    url = new URL(location, url)
    if (response.status === 303) request = { method: "GET" }
  }
  throw new Error("Unsubscribe URL exceeded the redirect limit")
}
