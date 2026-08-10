import dgram from "node:dgram"
import { networkInterfaces } from "node:os"
import { Bonjour } from "bonjour-service"
import dnsPacket from "dns-packet"

const MULTICAST_GROUP = "224.0.0.251"
const MDNS_PORT = 5353

let bonjour: Bonjour | undefined
let currentPort: number | undefined

function candidateInterfaces(): string[] {
  const addresses = new Set<string>()
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.internal || addr.family !== "IPv4") continue
      if (addr.address === "0.0.0.0" || addr.address.startsWith("169.254.")) continue
      addresses.add(addr.address)
    }
  }
  return [...addresses]
}

// Every address (IPv4 + IPv6) on the same interface as `target`. Used to
// restrict the A/AAAA records a given interface may advertise to only its own.
function addressesForInterface(target: string): Set<string> {
  const found = new Set<string>()
  for (const addrs of Object.values(networkInterfaces())) {
    const list = addrs ?? []
    if (!list.some((a) => a.address === target)) continue
    for (const a of list) {
      if (a.internal) continue
      if (a.family === "IPv4" || a.family === "IPv6") found.add(a.address)
    }
    break
  }
  return found
}

// bonjour-service builds one packet containing A/AAAA records for every
// interface and re-broadcasts the same bytes on all of them. A client on VLAN A
// would therefore see opencode.local -> <address-of-VLAN-B>. Rewrite the packet
// so it only advertises addresses belonging to the interface it is about to be
// sent on, mirroring multihomed mDNS responder behaviour.
interface DnsRecordLike {
  type: string
  data?: unknown
}

function filterPacketForInterface(buf: Uint8Array, keep: Set<string>): Buffer {
  try {
    const packet = dnsPacket.decode(buf)
    const filter = (records?: DnsRecordLike[]): DnsRecordLike[] | undefined => {
      if (!records) return records
      return records.filter((r) => {
        if (r.type === "A" || r.type === "AAAA") return keep.has(String(r.data))
        return true
      })
    }
    packet.answers = filter(packet.answers) as any
    packet.additionals = filter(packet.additionals) as any
    return dnsPacket.encode(packet)
  } catch {
    return Buffer.from(buf)
  }
}

type DgramSend = (...args: any[]) => any

function wrapMulticastSend(sock: dgram.Socket, getInterfaces: () => string[]) {
  const send = sock.send.bind(sock) as DgramSend
  const wrapped: DgramSend = (...args) => {
    // multicast-dns always calls the 6-arg form: send(msg, offset, length, port, host, cb)
    const [message, offset, length, port, host, callback] = args
    if (host !== MULTICAST_GROUP) {
      return send(...args)
    }
    const interfaces = getInterfaces()
    if (interfaces.length === 0) {
      return send(...args)
    }
    // Serialise the per-interface sends. setMulticastInterface() sets the
    // socket's IP_MULTICAST_IF, which is committed when the packet is dequeued
    // for transmission, not when send() is called. If all sends are fired
    // synchronously back-to-back, every queued packet picks up whichever
    // interface value was set last (deterministically vlan6, the last key in
    // networkInterfaces()). Waiting for each send's callback before changing
    // the interface guarantees each packet commits its own interface.
    let index = 0
    let lastErr: Error | undefined
    const next = (err?: Error) => {
      if (err) lastErr = err
      if (index >= interfaces.length) {
        if (callback) callback(lastErr)
        return
      }
      const address = interfaces[index++]
      try {
        sock.setMulticastInterface(address)
        const frame = filterPacketForInterface(message, addressesForInterface(address))
        send(frame, 0, frame.length, port, MULTICAST_GROUP, next)
      } catch {
        next()
      }
    }
    next()
    return sock
  }
  return wrapped
}

export function publish(port: number, domain?: string) {
  if (currentPort === port) return
  if (bonjour) unpublish()

  try {
    const host = domain ?? "opencode.local"
    const name = `opencode-${port}`

    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true })
    socket.on("error", () => {})
    socket.on("message", () => {})
    ;(socket as any).send = wrapMulticastSend(socket, candidateInterfaces)

    bonjour = new Bonjour({ socket: socket as any } as any)
    const service = bonjour.publish({
      name,
      type: "http",
      host,
      port,
      txt: { path: "/" },
    })

    service.on("error", () => {})

    currentPort = port
  } catch {
    if (bonjour) {
      try {
        bonjour.destroy()
      } catch {}
    }
    bonjour = undefined
    currentPort = undefined
  }
}

export function unpublish() {
  if (bonjour) {
    try {
      bonjour.unpublishAll()
      bonjour.destroy()
    } catch {}
    bonjour = undefined
    currentPort = undefined
  }
}

export * as MDNS from "./mdns"
