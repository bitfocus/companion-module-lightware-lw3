#!/usr/bin/env node
/**
 * Read-only walk of a Lightware router's LW3 tree, saved to captures/ for building the module and
 * its fake router. It only ever sends GET and MAN, so it can't change anything on the router.
 *
 *   node tools/lw3-capture.mjs ROUTER_IP
 *   node tools/lw3-capture.mjs ROUTER_IP --no-man      (skip the manual text: quicker, but less to learn from)
 *   node tools/lw3-capture.mjs ROUTER_IP --port 6107
 *
 * Addresses, serial numbers and host names are blanked in the saved file. Port and preset names are kept.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { Socket } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const COMMAND_TIMEOUT_MS = 5000
const MAX_TIMEOUTS_IN_A_ROW = 5
const CONNECT_TIMEOUT_MS = 5000
/** A pause between commands, so the walk doesn't crowd out anything else using the router */
const PACE_MS = 20
const MAX_NODES = 20000

/** The node names this walk will follow. Anything else a router lists is noted and skipped. */
const SAFE_PATH = /^\/[A-Za-z0-9_\-/]*$/
/** A property or method on a node, as listed by `GET path.*` */
const SAFE_MEMBER = /^\/[A-Za-z0-9_\-/]*[.:][A-Za-z0-9_-]+$/
const SENSITIVE_PROPERTY = /(serial|hostname|macaddress|username|password|passphrase)/i
const VERSION_PROPERTY = /(version|revision)/i
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g
const MAC = /\b[0-9a-f]{2}(?:[:-][0-9a-f]{2}){5}\b/gi

/** Blank anything that identifies the router or its network, keeping the shape of the line */
export function redact(line) {
	const property = /^\S+\s+\S*?\.([A-Za-z0-9_]+)=/.exec(line)?.[1]
	if (property && SENSITIVE_PROPERTY.test(property)) return line.replace(/=.*$/, '=[REDACTED]')
	if (property && VERSION_PROPERTY.test(property)) return line
	return line.replace(IPV4, '[IP]').replace(MAC, '[MAC]')
}

/** Child node paths from the reply to `GET path`. Lines look like `n- /MEDIA/VIDEO`. */
export function childNodes(lines) {
	const nodes = []
	for (const line of lines) {
		const match = /^n[-s]\s+(\S.*)$/.exec(line)
		if (match) nodes.push(match[1].trim())
	}
	return nodes
}

/** Properties and methods from the reply to `GET path.*`. Lines look like `pw /A/B.Name=1` or `m- /A/B:run`. */
export function members(lines) {
	const found = []
	for (const line of lines) {
		const match = /^(?:pr|pw|m-)\s+([^\s=]+)/.exec(line)
		if (match && SAFE_MEMBER.test(match[1])) found.push(match[1])
	}
	return found
}

/** The same member on another port shares its manual text: /A/I3.Foo5 and /A/I4.Foo6 both become /A/I#.Foo# */
export const memberShape = (member) => member.replace(/\d+/g, '#')

function parseArgs(argv) {
	const args = { host: undefined, port: 6107, man: true }
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--no-man') args.man = false
		else if (argv[i] === '--port') args.port = Number(argv[++i])
		else if (!args.host) args.host = argv[i]
	}
	return args
}

const READ_ONLY = /^(GET|MAN) \/[^\r\n]*$/

export class Lw3Reader {
	#allowed
	#socket = new Socket()
	#buffer = ''
	#nextId = 1
	#expected = undefined
	#block = undefined
	#finish = undefined
	/** Lines that arrived outside a reply, such as change messages */
	unsolicited = []
	closed = false
	/** Called with each line that arrives outside a reply */
	onUnsolicited = () => undefined

	constructor(allowed = READ_ONLY) {
		this.#allowed = allowed
	}

	connect(host, port) {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#socket.destroy()
				reject(new Error(`no answer on ${host}:${port} after ${CONNECT_TIMEOUT_MS / 1000} s`))
			}, CONNECT_TIMEOUT_MS)
			this.#socket.once('error', (error) => {
				clearTimeout(timer)
				reject(error)
			})
			this.#socket.once('connect', () => {
				clearTimeout(timer)
				this.#socket.removeAllListeners('error')
				this.#socket.on('error', () => this.#settle(undefined))
				resolve()
			})
			this.#socket.on('close', () => {
				this.closed = true
				this.#settle(undefined)
			})
			this.#socket.on('data', (chunk) => this.#onData(chunk.toString('latin1')))
			this.#socket.connect(port, host)
		})
	}

	close() {
		this.#socket.destroy()
	}

	/** Resolves with the reply's lines, or undefined if none came in time */
	request(command) {
		// The one place anything is written to the router
		if (!this.#allowed.test(command)) throw new Error(`refusing to send: ${command}`)
		const id = String(this.#nextId++ % 10000).padStart(4, '0')
		return new Promise((resolve) => {
			const timer = setTimeout(() => this.#settle(undefined), COMMAND_TIMEOUT_MS)
			this.#expected = id
			this.#block = undefined
			this.#finish = (lines) => {
				clearTimeout(timer)
				resolve(lines)
			}
			this.#socket.write(`${id}#${command}\r\n`)
		})
	}

	#settle(lines) {
		const finish = this.#finish
		this.#finish = undefined
		this.#expected = undefined
		this.#block = undefined
		finish?.(lines)
	}

	#onData(text) {
		this.#buffer += text
		let end
		while ((end = this.#buffer.indexOf('\r\n')) !== -1) {
			this.#onLine(this.#buffer.slice(0, end))
			this.#buffer = this.#buffer.slice(end + 2)
		}
	}

	#onLine(line) {
		if (this.#block) {
			if (line === '}') this.#settle(this.#block)
			else this.#block.push(line)
		} else if (this.#expected && line === `{${this.#expected}`) {
			this.#block = []
		} else if (line.trim() !== '') {
			this.unsolicited.push(line)
			this.onUnsolicited(line)
		}
	}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
	const { host, port, man } = parseArgs(process.argv.slice(2))
	if (!host || !Number.isInteger(port)) {
		console.error('Usage: node tools/lw3-capture.mjs ROUTER_IP [--no-man] [--port 6107]')
		process.exit(2)
	}

	const reader = new Lw3Reader()
	try {
		await reader.connect(host, port)
	} catch (error) {
		console.error(`Couldn't connect: ${error.message}`)
		console.error('If the address is right, this router may not offer LW3 on this port.')
		process.exit(1)
	}
	console.log('Connected. Only GET and MAN will be sent.')

	const output = []
	const failures = []
	const skipped = []
	let timeoutsInARow = 0
	let commandCount = 0

	const ask = async (command) => {
		if (reader.closed) return undefined
		await sleep(PACE_MS)
		commandCount++
		const lines = await reader.request(command)
		output.push(`>>> ${command}`)
		if (lines === undefined) {
			output.push('!!! no reply')
			failures.push(command)
			timeoutsInARow++
		} else {
			timeoutsInARow = 0
			output.push(...lines.map(redact))
		}
		return lines
	}

	const seen = new Set(['/'])
	const toVisit = ['/']
	const manualsRead = new Set()
	let product = 'unknown-model'
	let firmware = 'unknown-firmware'

	while (toVisit.length > 0 && !reader.closed && timeoutsInARow < MAX_TIMEOUTS_IN_A_ROW) {
		const path = toVisit.shift()
		const properties = await ask(path === '/' ? 'GET /.*' : `GET ${path}.*`)
		for (const line of properties ?? []) {
			product = /^\S+\s+\/\.ProductName=(.+)$/.exec(line)?.[1] ?? product
			// The walk goes shallowest first, so the first one is the router's own and not an I/O board's
			if (firmware === 'unknown-firmware') firmware = /^\S+\s+\S*\.FirmwareVersion=(.+)$/.exec(line)?.[1] ?? firmware
		}
		// Routers don't answer `MAN path.*`, so ask about each kind of property and method once
		if (man) {
			for (const member of members(properties ?? [])) {
				const shape = memberShape(member)
				if (manualsRead.has(shape)) continue
				manualsRead.add(shape)
				await ask(`MAN ${member}`)
			}
		}

		for (const child of childNodes((await ask(`GET ${path}`)) ?? [])) {
			if (!SAFE_PATH.test(child)) skipped.push(child)
			else if (!seen.has(child) && seen.size < MAX_NODES) {
				seen.add(child)
				toVisit.push(child)
			}
		}
		process.stdout.write(`\r${seen.size - toVisit.length}/${seen.size} nodes, ${commandCount} commands   `)
	}
	process.stdout.write('\n')
	reader.close()

	const incomplete = toVisit.length > 0
	const header = [
		`# LW3 capture of ${product}, firmware ${firmware}`,
		`# ${new Date().toISOString()}, ${seen.size} nodes, ${commandCount} commands, ${failures.length} without a reply`,
		...(incomplete ? [`# INCOMPLETE: stopped with ${toVisit.length} nodes still to read`] : []),
		...skipped.map((path) => `# skipped node with an unexpected name: ${path}`),
		...reader.unsolicited.map((line) => `# arrived outside a reply: ${redact(line)}`),
	]

	const safeName = (text) => text.replace(/[^A-Za-z0-9._-]+/g, '_')
	const directory = join(dirname(fileURLToPath(import.meta.url)), '..', 'captures')
	mkdirSync(directory, { recursive: true })
	const file = join(directory, `${safeName(product)}_${safeName(firmware)}.txt`)
	writeFileSync(file, [...header, ...output, ''].join('\n'))

	console.log(`Model: ${product}, firmware: ${firmware}`)
	console.log(`Commands without a reply: ${failures.length}`)
	if (incomplete) console.log(`INCOMPLETE: stopped with ${toVisit.length} nodes still to read. Run it again.`)
	console.log(`Saved to ${file}`)
	if (seen.size === 1) console.log('Only the root was found, so this router may not answer LW3 as expected.')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
