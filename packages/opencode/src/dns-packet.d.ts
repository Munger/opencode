declare module "dns-packet" {
  interface DnsRecord {
    name: string
    type: string
    ttl: number
    data?: unknown
  }

  interface DnsPacket {
    type?: string
    flags?: number
    id?: number
    questions?: unknown[]
    answers?: DnsRecord[]
    additionals?: DnsRecord[]
  }

  function decode(buf: Uint8Array): DnsPacket
  function encode(packet: DnsPacket): Buffer

  const packet: {
    decode: typeof decode
    encode: typeof encode
  }

  export default packet
}
