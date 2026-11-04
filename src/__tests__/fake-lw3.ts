import { createServer, type AddressInfo, type Server, type Socket } from 'node:net'

const XP = '/MEDIA/XP/VIDEO'
const NAMES = '/MEDIA/NAMES/VIDEO'
const PRESET = '/MEDIA/PRESET'

interface Port {
	name: string
	prefix: string
	connected: boolean
	signal: boolean
	locked: boolean
	muted: boolean
}

export interface FakeLw3Options {
	inputs?: number
	outputs?: number
	/** Replaces the crosspoint properties, as on a router this module doesn't know */
	noRouting?: boolean
}

const newPort = (name: string): Port => ({
	name,
	prefix: '2',
	connected: false,
	signal: false,
	locked: false,
	muted: false,
})

/**
 * Behaves as a real MX2-8x8-HDMI20-L did when measured, including where that disagrees with its own manual
 * text. Recalling a preset hasn't been measured yet, so that part is a guess at the same style of reply.
 */
export class FakeLw3 {
	readonly routes: number[]
	readonly inputs: Port[]
	readonly outputs: Port[]
	readonly presets = new Map<string, string[]>()
	/** Everything received, without the ids */
	readonly received: string[] = []
	/** Stop answering, while staying connected */
	silent = false
	readonly #noRouting: boolean
	readonly #clients = new Map<Socket, { buffer: string; subscribed: Set<string> }>()
	#server: Server | undefined

	constructor(options: FakeLw3Options = {}) {
		const inputs = options.inputs ?? 8
		const outputs = options.outputs ?? 8
		this.inputs = Array.from({ length: inputs }, (_, i) => newPort(`Input ${i + 1}`))
		this.outputs = Array.from({ length: outputs }, (_, i) => newPort(`Output ${i + 1}`))
		this.routes = Array.from({ length: outputs }, () => 0)
		this.#noRouting = options.noRouting === true
		this.presets.set(
			'SHOW-A',
			Array.from({ length: outputs }, () => 'uI1'),
		)
		this.presets.set(
			'SHOW-B',
			Array.from({ length: outputs }, () => 'uI2'),
		)
	}

	async listen(port = 0): Promise<number> {
		this.#server = createServer((socket) => this.#accept(socket))
		await new Promise<void>((resolve) => this.#server?.listen(port, '127.0.0.1', resolve))
		return (this.#server.address() as AddressInfo).port
	}

	async close(): Promise<void> {
		for (const socket of this.#clients.keys()) socket.destroy()
		this.#clients.clear()
		await new Promise<void>((resolve) => {
			if (this.#server) this.#server.close(() => resolve())
			else resolve()
		})
		this.#server = undefined
	}

	dropClients(): void {
		for (const socket of this.#clients.keys()) socket.destroy()
	}

	/** A change made on the front panel or web UI: subscribers hear about it */
	routeFromPanel(input: number, output: number): void {
		this.routes[output - 1] = input
		this.#announce(XP, `DestinationConnectionStatus=${this.#routeList()}`)
	}

	renameFromPanel(port: string, name: string): void {
		this.#target(port).name = name
		this.#announce(NAMES, `${port}=${this.#target(port).prefix};${name}`)
	}

	/** A preset saved elsewhere. Whether a real router announces this hasn't been measured. */
	savePresetFromPanel(name: string, routes: string[]): void {
		this.presets.set(name, routes)
		for (const [socket, client] of this.#clients) {
			if (client.subscribed.has(`${PRESET}/*`)) {
				socket.write(`CHG ${PRESET}/${name}.VideoDestination=${routes.join(';')};\r\n`)
			}
		}
	}

	setSignal(port: string, connected: boolean, signal: boolean): void {
		const target = this.#target(port)
		target.connected = connected
		target.signal = signal
		if (port.startsWith('I')) this.#announce(XP, `SourcePortStatus=${statusList(this.inputs)}`)
		else this.#announce(XP, `DestinationPortStatus=${statusList(this.outputs)}`)
	}

	/** The reply to one command, and any change messages, which the router sends ahead of the reply */
	respond(command: string): { reply: string[]; changes: [string, string][] } {
		const changes: [string, string][] = []
		const reply = this.#execute(command, changes)
		return { reply, changes }
	}

	#target(port: string): Port {
		const list = port.startsWith('I') ? this.inputs : this.outputs
		return list[Number(port.slice(1)) - 1]
	}

	#routeList(): string {
		return `${this.routes.map((input) => (input === 0 ? '0' : `I${input}`)).join(';')};`
	}

	#accept(socket: Socket): void {
		this.#clients.set(socket, { buffer: '', subscribed: new Set() })
		socket.on('error', () => undefined)
		socket.on('close', () => this.#clients.delete(socket))
		socket.on('data', (data) => {
			const client = this.#clients.get(socket)
			if (!client) return
			client.buffer += data.toString('latin1')
			let end
			while ((end = client.buffer.indexOf('\r\n')) !== -1) {
				const line = client.buffer.slice(0, end)
				client.buffer = client.buffer.slice(end + 2)
				if (!this.silent) this.#handle(socket, line)
			}
		})
	}

	#handle(socket: Socket, line: string): void {
		const match = /^(\d{4})#(.*)$/.exec(line)
		if (!match) return
		const [, id, command] = match
		this.received.push(command)
		if (command.startsWith('OPEN ')) this.#clients.get(socket)?.subscribed.add(command.slice(5))
		const { reply, changes } = this.respond(command)
		for (const [path, property] of changes) this.#announce(path, property)
		socket.write(`{${id}\r\n${reply.map((text) => `${text}\r\n`).join('')}}\r\n`)
	}

	#announce(path: string, property: string): void {
		for (const [socket, client] of this.#clients) {
			if (client.subscribed.has(path)) socket.write(`CHG ${path}.${property}\r\n`)
		}
	}

	#execute(command: string, changes: [string, string][]): string[] {
		const notExists = (path: string, prefix = 'pE'): string[] => [`${prefix} ${path} %E002: Not exists`]
		const open = /^OPEN (\S+)$/.exec(command)
		if (open) return [`o- ${open[1]}`]

		const call = /^CALL (\S+?):(\w+)\((.*)\)$/.exec(command)
		if (call) return this.#call(call[1], call[2], call[3], changes)

		const set = /^SET \/MEDIA\/NAMES\/VIDEO\.([IO]\d+)=(.*)$/.exec(command)
		if (set) return this.#setName(set[1], set[2], changes)

		const get = /^GET (.*)$/.exec(command)
		if (!get) return notExists(command)
		const target = get[1]
		if (target === '/.ProductName') return ['pr /.ProductName=MX2-8x8-HDMI20-L']
		if (target === '/MANAGEMENT/UID.FirmwareVersion') return ['pr /MANAGEMENT/UID.FirmwareVersion=1.10.1b4']
		if (this.#noRouting && target.startsWith(XP)) return notExists(target)
		if (target === `${XP}.DestinationConnectionStatus`) {
			return [`pr ${XP}.DestinationConnectionStatus=${this.#routeList()}`]
		}
		if (target === `${XP}.DestinationPortStatus`) return [`pr ${XP}.DestinationPortStatus=${statusList(this.outputs)}`]
		if (target === `${XP}.SourcePortStatus`) return [`pr ${XP}.SourcePortStatus=${statusList(this.inputs)}`]
		if (target === `${NAMES}.*`) {
			return [
				...this.inputs.map((port, i) => `pw ${NAMES}.I${i + 1}=${port.prefix};${port.name}`),
				...this.outputs.map((port, i) => `pw ${NAMES}.O${i + 1}=${port.prefix};${port.name}`),
			]
		}
		if (target === PRESET) return [...this.presets.keys()].map((name) => `n- ${PRESET}/${name}`)
		const presetRoutes = /^\/MEDIA\/PRESET\/([^.]+)\.VideoDestination$/.exec(target)
		const stored = presetRoutes ? this.presets.get(presetRoutes[1]) : undefined
		if (presetRoutes && stored) return [`pw ${target}=${stored.join(';')};`]
		return notExists(target)
	}

	#call(path: string, method: string, args: string, changes: [string, string][]): string[] {
		const fail = (code: string, text: string): string[] => [`mE ${path}:${method} %${code}: ${text}`]
		const ok = [`mO ${path}:${method}=OK`]
		if (method === 'softReset') return ok

		const preset = /^\/MEDIA\/PRESET\/(.+)$/.exec(path)
		if (preset && method === 'load') {
			const stored = this.presets.get(preset[1])
			if (!stored) return fail('E002', 'Not exists')
			stored.forEach((entry, index) => {
				const match = /I(\d+)$/.exec(entry)
				this.routes[index] = match ? Number(match[1]) : 0
			})
			changes.push([XP, `DestinationConnectionStatus=${this.#routeList()}`])
			return ok
		}

		if (path !== XP) return fail('E002', 'Not exists')
		if (method === 'switch') return this.#switch(args, ok, fail, changes)
		const lock = /^(un)?lockDestination$/.exec(method)
		if (lock) {
			const port = this.outputs[Number(args.slice(1)) - 1]
			const wanted = !lock[1]
			// measured: asking for the state it is already in gets this misleading error
			if (port.locked === wanted) return fail('E002', 'Not exists')
			port.locked = wanted
			changes.push([XP, `DestinationPortStatus=${statusList(this.outputs)}`])
			return ok
		}
		return fail('E002', 'Not exists')
	}

	#switch(
		args: string,
		ok: string[],
		fail: (code: string, text: string) => string[],
		changes: [string, string][],
	): string[] {
		const routes: [number, number][] = []
		for (const part of args.split(';')) {
			const match = /^(?:I(\d+)|0):O(\d+)$/.exec(part)
			if (part.includes(',') || (!match && !/^I\d+:O\d+$/.test(part))) return fail('E001', 'Syntax error')
			if (!match) return fail('E001', 'Syntax error')
			const input = match[1] === undefined ? 0 : Number(match[1])
			// measured: I0 is refused, and the manual's way of unrouting is wrong
			if (match[1] !== undefined && input === 0) return fail('E002', 'Not exists')
			routes.push([input, Number(match[2])])
		}
		if (routes.some(([, output]) => this.outputs[output - 1]?.locked)) return fail('E007', 'Access denied')
		let changed = false
		for (const [input, output] of routes) {
			if (this.routes[output - 1] !== input) changed = true
			this.routes[output - 1] = input
		}
		// measured: several routes make one change message, and an unchanged route makes none
		if (changed) changes.push([XP, `DestinationConnectionStatus=${this.#routeList()}`])
		return ok
	}

	#setName(portId: string, value: string, changes: [string, string][]): string[] {
		const match = /^(\d+);(.*)$/.exec(value)
		if (!match) return [`pE ${NAMES}.${portId} %E004: Invalid value`]
		const port = this.#target(portId)
		port.prefix = match[1]
		port.name = match[2].slice(0, 62)
		const stored = `${portId}=${port.prefix};${port.name}`
		changes.push([NAMES, stored])
		return [`pw ${NAMES}.${stored}`]
	}
}

function statusList(ports: Port[]): string {
	return `${ports
		.map((port) => {
			const letter = port.locked && port.muted ? 'U' : port.locked ? 'L' : port.muted ? 'M' : 'T'
			const digit = (0b1010 | (port.connected ? 0b0001 : 0) | (port.signal ? 0b0100 : 0)).toString(16).toUpperCase()
			return `${letter}A${digit}`
		})
		.join(';')};`
}

/** Waits for a condition, for tests against real sockets */
export async function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
	const started = Date.now()
	while (!condition()) {
		if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for condition')
		await new Promise((resolve) => setTimeout(resolve, 5))
	}
}
