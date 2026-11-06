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

interface Slot {
	name: string
	resolution: string
	valid: boolean
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
	routerName = 'MX2-8x8-HDMI20-L'
	firmware = '1.10.1b4'
	/** NORMAL or STANDBY. In standby every change is refused. */
	power = 'NORMAL'
	sourceDetail = 'F;F;0;0;0;0;0;0;'
	destinationDetail = 'F;0;0;0;0;0;0;0;'
	readonly routes: number[]
	readonly inputs: Port[]
	readonly outputs: Port[]
	readonly presets = new Map<string, string[]>()
	readonly edidSlots = new Map<string, Slot>()
	readonly emulated: string[]
	readonly inputHdcp: string[]
	readonly outputHdcp: string[]
	/** The front panel's preset buttons, the preset each holds or '' */
	readonly slots: string[] = Array.from({ length: 8 }, () => '')
	/** `EnableHPD` on inputs, AUTO or OFF */
	readonly inputHotplug: string[]
	/** `Enable5V` on outputs, true or false */
	readonly output5v: string[]
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
		this.emulated = Array.from({ length: inputs }, () => 'F137')
		this.inputHdcp = Array.from({ length: inputs }, () => '2')
		this.outputHdcp = Array.from({ length: outputs }, () => 'AUTO')
		this.inputHotplug = Array.from({ length: inputs }, () => 'AUTO')
		this.output5v = Array.from({ length: outputs }, () => 'true')
		this.edidSlots.set('F1', { name: 'D640x480p60', resolution: '640x480p60.00Hz', valid: true })
		this.edidSlots.set('F137', { name: 'HUHDp60_444', resolution: '3840x2160p60.00Hz', valid: true })
		for (let i = 1; i <= outputs; i++) {
			this.edidSlots.set(`D${i}`, { name: `Display ${i}`, resolution: '1920x1080p50.00Hz', valid: true })
		}
		for (let i = 1; i <= 100; i++) this.edidSlots.set(`U${i}`, { name: '', resolution: '', valid: false })
		this.edidSlots.set('U1', { name: 'Extron D     ', resolution: '1920x1080p50.00Hz', valid: true })
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
	/**
	 * As measured: a new preset is announced as NEW to `OPEN /MEDIA/PRESET` only, and a changed one as a
	 * CHG to `OPEN /MEDIA/PRESET/*` only, and only if its routes are different
	 */
	savePresetFromPanel(name: string, routes: string[]): void {
		const before = this.presets.get(name)
		this.presets.set(name, routes)
		if (!before) this.#announceLine(PRESET, `NEW ${PRESET}/${name}`)
		else if (before.join(';') !== routes.join(';'))
			this.#announce(`${PRESET}/*`, `${name}.VideoDestination=${routes.join(';')};`, PRESET)
	}

	announceSlot(slot: number): void {
		this.#announce(PRESET, `Button${slot}AssignedPreset=${this.slots[slot - 1]}`)
	}

	deletePresetFromPanel(name: string): void {
		this.presets.delete(name)
		this.#announceLine(PRESET, `DEL ${PRESET}/${name}`)
	}

	/** A semicolon list of first digits, as the router's web interface reads them */
	setDetail(direction: 'Source' | 'Destination', value: string): void {
		if (direction === 'Source') this.sourceDetail = value
		else this.destinationDetail = value
		this.#announce(XP, `${direction}PortGuiStatus=${value}`)
	}

	/** As when a port is changed on the router's own web page */
	announceStatus(): void {
		this.#announce(XP, `SourcePortStatus=${statusList(this.inputs)}`)
		this.#announce(XP, `DestinationPortStatus=${statusList(this.outputs)}`)
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

	/** `path` is what a client opened, and `node` what the change message names, if different */
	#announce(path: string, property: string, node = path): void {
		// a change heard through a wildcard names the child, such as /MEDIA/PRESET/SHOW-A.VideoDestination
		this.#announceLine(path, `CHG ${node}${node === path ? '.' : '/'}${property}`)
	}

	#announceLine(path: string, line: string): void {
		for (const [socket, client] of this.#clients) {
			if (client.subscribed.has(path)) socket.write(`${line}\r\n`)
		}
	}

	#execute(command: string, changes: [string, string][]): string[] {
		const notExists = (path: string, prefix = 'pE'): string[] => [`${prefix} ${path} %E002: Not exists`]
		const power = /^CALL \/MANAGEMENT\/POWER:(standby|wakeUp)\(\)$/.exec(command)
		if (power) {
			const wanted = power[1] === 'standby' ? 'STANDBY' : 'NORMAL'
			if (this.power === wanted) return [`mE /MANAGEMENT/POWER:${power[1]} %E006: Illegal operation`]
			this.power = wanted
			changes.push(['/MANAGEMENT/POWER', `Operation=${wanted}`])
			return [`mO /MANAGEMENT/POWER:${power[1]}=`]
		}
		if (command === 'GET /MANAGEMENT/POWER.Operation') return [`pr /MANAGEMENT/POWER.Operation=${this.power}`]
		// measured: in standby, every change gets this, whatever it is
		const change = /^(CALL|SET) (\S+?)(?:[:.=]|$)/.exec(command)
		if (change && this.power === 'STANDBY') {
			return [`${change[1] === 'CALL' ? 'mE' : 'pE'} ${change[2]} %E012: Node disabled or standby mode active`]
		}
		const open = /^OPEN (\S+)$/.exec(command)
		if (open) return [`o- ${open[1]}`]

		const call = /^CALL (\S+?):(\w+)\((.*)\)$/.exec(command)
		if (call) return this.#call(call[1], call[2], call[3], changes)

		const set = /^SET \/MEDIA\/NAMES\/VIDEO\.([IO]\d+)=(.*)$/.exec(command)
		if (set) return this.#setName(set[1], set[2], changes)

		const label = /^SET \/MANAGEMENT\/UID\.DeviceLabel=(.*)$/.exec(command)
		if (label) {
			this.routerName = label[1].slice(0, 39)
			changes.push(['/MANAGEMENT/UID', `DeviceLabel=${escaped(this.routerName)}`])
			return [`pw /MANAGEMENT/UID.DeviceLabel=${escaped(this.routerName)}`]
		}
		const hdcp = /^SET (\/MEDIA\/PORTS\/VIDEO\/([IO])(\d+)\/SETTINGS)\.(HdcpVersion|HdcpMode)=(.*)$/.exec(command)
		if (hdcp) return this.#setHdcp(hdcp[1], hdcp[2], Number(hdcp[3]), hdcp[4], hdcp[5], changes)

		const slot = /^SET \/MEDIA\/PRESET\.Button(\d+)AssignedPreset=(.*)$/.exec(command)
		if (slot) {
			this.slots[Number(slot[1]) - 1] = slot[2]
			changes.push([PRESET, `Button${slot[1]}AssignedPreset=${slot[2]}`])
			return [`pw ${PRESET}.Button${slot[1]}AssignedPreset=${slot[2]}`]
		}
		const write = /^SET \/MEDIA\/PRESET\/([^.]+)\.VideoDestination=(.*)$/.exec(command)
		if (write) {
			const entries = write[2].split(';')
			// measured: one entry per output, and the trailing semicolon
			if (!this.presets.has(write[1]) || entries.pop() !== '' || entries.length !== this.outputs.length) {
				return [`pE ${PRESET}/${write[1]}.VideoDestination %E004: Invalid value`]
			}
			this.savePresetFromPanel(write[1], entries)
			return [`pw ${PRESET}/${write[1]}.VideoDestination=${write[2]}`]
		}
		const hotplug = /^SET (\/MEDIA\/PORTS\/VIDEO\/([IO])(\d+)\/SETTINGS)\.(EnableHPD|Enable5V)=(.*)$/.exec(command)
		if (hotplug) {
			const [, path, kind, number, property, value] = hotplug
			const list = kind === 'I' ? this.inputHotplug : this.output5v
			const allowed = kind === 'I' ? ['AUTO', 'OFF'] : ['true', 'false']
			if (!allowed.includes(value) || (kind === 'I') !== (property === 'EnableHPD')) {
				return [`pE ${path}.${property} %E004: Invalid value`]
			}
			list[Number(number) - 1] = value
			changes.push([path, `${property}=${value}`])
			return [`pw ${path}.${property}=${value}`]
		}

		const get = /^GET (.*)$/.exec(command)
		if (!get) return notExists(command)
		const target = get[1]
		if (target === '/.ProductName') return ['pr /.ProductName=MX2-8x8-HDMI20-L']
		if (target === '/MANAGEMENT/UID.FirmwareVersion') return [`pr /MANAGEMENT/UID.FirmwareVersion=${this.firmware}`]
		if (target === '/MANAGEMENT/UID.DeviceLabel') return [`pw /MANAGEMENT/UID.DeviceLabel=${escaped(this.routerName)}`]
		if (target === `${XP}.SourcePortGuiStatus`) return [`pr ${XP}.SourcePortGuiStatus=${this.sourceDetail}`]
		if (target === `${XP}.DestinationPortGuiStatus`)
			return [`pr ${XP}.DestinationPortGuiStatus=${this.destinationDetail}`]
		if (this.#noRouting && target.startsWith(XP)) return notExists(target)
		if (target === `${XP}.DestinationConnectionStatus`) {
			return [`pr ${XP}.DestinationConnectionStatus=${this.#routeList()}`]
		}
		if (target === `${XP}.DestinationPortStatus`) return [`pr ${XP}.DestinationPortStatus=${statusList(this.outputs)}`]
		if (target === `${XP}.SourcePortStatus`) return [`pr ${XP}.SourcePortStatus=${statusList(this.inputs)}`]
		if (target === '/EDID.EdidStatus') return [`pr /EDID.EdidStatus=${this.emulated.join(';')}`]
		const wildcard = /^\/EDID\/([FDU])\/\*\.(Validity|MonitorName|PreferredResolution)$/.exec(target)
		if (wildcard) return this.#edidBank(wildcard[1], wildcard[2])
		const setting = /^\/MEDIA\/PORTS\/VIDEO\/([IO])(\d+)\/SETTINGS\.(HdcpVersion|HdcpMode)$/.exec(target)
		if (setting) {
			const value = (setting[1] === 'I' ? this.inputHdcp : this.outputHdcp)[Number(setting[2]) - 1]
			return [`pw ${target}=${value}`]
		}
		const hotplugGet = /^\/MEDIA\/PORTS\/VIDEO\/(I(\d+)\/SETTINGS\.EnableHPD|O(\d+)\/SETTINGS\.Enable5V)$/.exec(target)
		if (hotplugGet) {
			const value = hotplugGet[2]
				? this.inputHotplug[Number(hotplugGet[2]) - 1]
				: this.output5v[Number(hotplugGet[3]) - 1]
			return [`pw ${target}=${value}`]
		}
		if (target.startsWith('/MEDIA/PORTS/VIDEO/') && target.includes('*')) return notExists(target)
		if (target === `${NAMES}.*`) {
			return [
				...this.inputs.map((port, i) => `pw ${NAMES}.I${i + 1}=${port.prefix};${escaped(port.name)}`),
				...this.outputs.map((port, i) => `pw ${NAMES}.O${i + 1}=${port.prefix};${escaped(port.name)}`),
			]
		}
		if (target === PRESET) return [...this.presets.keys()].map((name) => `n- ${PRESET}/${name}`)
		if (target === `${PRESET}.*`)
			return this.slots.map((name, index) => `pw ${PRESET}.Button${index + 1}AssignedPreset=${name}`)
		const presetRoutes = /^\/MEDIA\/PRESET\/([^.]+)\.VideoDestination$/.exec(target)
		const stored = presetRoutes ? this.presets.get(presetRoutes[1]) : undefined
		if (presetRoutes && stored) return [`pw ${target}=${stored.join(';')};`]
		return notExists(target)
	}

	#call(path: string, method: string, args: string, changes: [string, string][]): string[] {
		const fail = (code: string, text: string): string[] => [`mE ${path}:${method} %${code}: ${text}`]
		const ok = [`mO ${path}:${method}=OK`]
		if (method === 'softReset') return ok

		if (path === '/EDID') return this.#callEdid(method, args, ok, fail, changes)

		if (path === PRESET) return this.#callPresets(method, args, fail)
		const preset = /^\/MEDIA\/PRESET\/(.+)$/.exec(path)
		if (preset && method === 'save') {
			const stored = this.presets.get(preset[1])
			if (!stored) return fail('E002', 'Not exists')
			this.savePresetFromPanel(preset[1], this.#presetRoutes())
			return [`mO ${path}:${method}=Ok`]
		}
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
		const mute = /^(un)?mute(Source|Destination)$/.exec(method)
		if (mute) {
			const source = mute[2] === 'Source'
			const match = new RegExp(`^${source ? 'I' : 'O'}(\\d+)$`).exec(args)
			const port = match ? (source ? this.inputs : this.outputs)[Number(match[1]) - 1] : undefined
			const wanted = !mute[1]
			// measured: the wrong kind of port, the state it is already in, and a locked output all get this
			if (!port || port.muted === wanted || port.locked) return fail('E002', 'Not exists')
			port.muted = wanted
			const property = source ? 'SourcePortStatus' : 'DestinationPortStatus'
			changes.push([XP, `${property}=${statusList(source ? this.inputs : this.outputs)}`])
			return ok
		}
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

	/** The routes as a preset holds them, such as uI1 */
	#presetRoutes(): string[] {
		return this.routes.map((input) => (input === 0 ? 'u0' : `uI${input}`))
	}

	/** As measured: the manual's comma form, a new preset holding what is routed now, and NEW and DEL */
	#callPresets(method: string, args: string, fail: (code: string, text: string) => string[]): string[] {
		const parts = args.split(',')
		const done = [`mO ${PRESET}:${method}=`]
		if (method === 'create') {
			if (parts.length !== 2 || parts[1] !== 'VIDEO') return fail('E004', 'Invalid value')
			if (this.presets.has(parts[0])) return fail('E003', 'Already exists')
			this.savePresetFromPanel(parts[0], this.#presetRoutes())
			return done
		}
		if (method === 'createButtonAssignedPreset') {
			const slot = Number(parts[0])
			if (parts.length !== 2 || parts[1] !== 'VIDEO' || !(slot >= 1 && slot <= this.slots.length)) {
				return fail('E004', 'Invalid value')
			}
			const name = `Button${slot}`
			this.savePresetFromPanel(name, this.#presetRoutes())
			this.slots[slot - 1] = name
			this.#announce(PRESET, `Button${slot}AssignedPreset=${name}`)
			return done
		}
		if (method === 'delete') {
			if (!this.presets.has(args)) return fail('E002', 'Not exists')
			this.deletePresetFromPanel(args)
			return done
		}
		if (method === 'copy' || method === 'rename') {
			const [from, to] = parts
			const stored = this.presets.get(from)
			if (parts.length !== 2 || !stored) return fail('E002', 'Not exists')
			if (this.presets.has(to)) return fail('E003', 'Already exists')
			this.savePresetFromPanel(to, [...stored])
			if (method === 'rename') this.deletePresetFromPanel(from)
			return done
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
		// measured: 0, 1, 2, 3 and x are accepted, 9 and 12 are not, and a name can't be empty
		const match = /^([0-3]|x);(.+)$/.exec(value)
		if (!match) return [`pE ${NAMES}.${portId} %E004: Invalid value`]
		const port = this.#target(portId)
		port.prefix = match[1]
		port.name = match[2].slice(0, 62)
		const stored = `${portId}=${port.prefix};${escaped(port.name)}`
		changes.push([NAMES, stored])
		return [`pw ${NAMES}.${stored}`]
	}

	#setHdcp(
		path: string,
		kind: string,
		port: number,
		property: string,
		value: string,
		changes: [string, string][],
	): string[] {
		const allowed = kind === 'I' ? ['0', '2', '3'] : ['AUTO', 'ALWAYS']
		if (!allowed.includes(value)) return [`pE ${path}.${property} %E004: Invalid value`]
		const list = kind === 'I' ? this.inputHdcp : this.outputHdcp
		if (list[port - 1] !== value) changes.push([path, `${property}=${value}`])
		list[port - 1] = value
		return [`pw ${path}.${property}=${value}`]
	}

	/** Measured: all the slots in a bank come back in text order, F1, F10, F100, with empty ones as blank values */
	#edidBank(bank: string, property: string): string[] {
		const ids = [...this.edidSlots.keys()].filter((id) => id.startsWith(bank)).sort()
		return ids.map((id) => {
			const slot = this.edidSlots.get(id) as Slot
			const value = property === 'Validity' ? slot.valid : property === 'MonitorName' ? slot.name : slot.resolution
			return `pr /EDID/${bank}/${id}.${property}=${String(value)}`
		})
	}

	#callEdid(
		method: string,
		args: string,
		ok: string[],
		fail: (code: string, text: string) => string[],
		changes: [string, string][],
	): string[] {
		const empty = [`mO /EDID:${method}=`]
		if (method === 'switch') {
			const pairs = args.split(';').map((part) => /^([FDU]\d+):E(\d+)$/.exec(part))
			// measured: it announces the status even when it refuses
			changes.push(['/EDID', `EdidStatus=${this.emulated.join(';')}`])
			if (pairs.some((pair) => !pair || !this.edidSlots.has(pair[1]))) return fail('E004', 'Invalid value')
			for (const pair of pairs) if (pair) this.emulated[Number(pair[2]) - 1] = pair[1]
			changes.pop()
			changes.push(['/EDID', `EdidStatus=${this.emulated.join(';')}`])
			return empty
		}
		if (method === 'copy') {
			const pair = /^([FDU]\d+):(U\d+)$/.exec(args)
			const from = pair && this.edidSlots.get(pair[1])
			if (!pair || !from) return fail('E004', 'Invalid value')
			this.edidSlots.set(pair[2], { ...from })
			return empty
		}
		if (method === 'delete') {
			if (!/^U\d+$/.test(args) || !this.edidSlots.has(args)) return fail('E004', 'Invalid value')
			this.edidSlots.set(args, { name: '', resolution: '', valid: false })
			return empty
		}
		return ok
	}
}

/** Measured: these characters come back with a backslash in front */
const escaped = (name: string): string => name.replace(/[()#%\\]/g, '\\$&')

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
