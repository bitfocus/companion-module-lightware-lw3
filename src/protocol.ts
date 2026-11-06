/**
 * The LW3 protocol as measured on an MX2-8x8-HDMI20-L, firmware 1.10.1b4. Where the router's own manual
 * text and its behaviour disagree, this follows the behaviour: the manual gives `switch(I1,O1)` for
 * example, which the router rejects with a syntax error.
 */

export const DEFAULT_PORT = 6107

const XP = '/MEDIA/XP/VIDEO'
const NAMES = '/MEDIA/NAMES/VIDEO'
const PRESETS = '/MEDIA/PRESET'
const PORTS = '/MEDIA/PORTS/VIDEO'
const UID = '/MANAGEMENT/UID'
export const POWER = '/MANAGEMENT/POWER'

export const EDID_BANKS = ['F', 'D', 'U'] as const
export type EdidBank = (typeof EDID_BANKS)[number]
export type EdidProperty = 'Validity' | 'MonitorName' | 'PreferredResolution'

/** Longest name the router stores: it keeps the first 62 characters of anything longer */
export const MAX_NAME_LENGTH = 62
/** Longest router name it stores, keeping the first 39 characters of anything longer */
export const MAX_ROUTER_NAME_LENGTH = 39
/** Measured: the router stops seeing a display about 1 s after its 5V goes off, so 2 s is enough */
export const HOTPLUG_DEFAULT_SECONDS = 2
export const HOTPLUG_MAX_SECONDS = 10

/** Paths are built from preset names, so a name that could change the command never reaches the router */
/** The router took 46 characters, and spaces and dots too, but those would end up inside commands */
const SAFE_PRESET_NAME = /^[A-Za-z0-9_-]{1,46}$/

export const isSafePresetName = (name: string): boolean => SAFE_PRESET_NAME.test(name)

export type PortId = `I${number}` | `O${number}`

/** A route: the input to send to the output, with input 0 meaning no input */
export interface Route {
	input: number
	output: number
}

const routeText = ({ input, output }: Route): string => `${input === 0 ? '0' : `I${input}`}:O${output}`

export const Cmd = {
	productName: 'GET /.ProductName',
	firmware: 'GET /MANAGEMENT/UID.FirmwareVersion',
	subscribeRouting: `OPEN ${XP}`,
	subscribeNames: `OPEN ${NAMES}`,
	subscribeRouterName: `OPEN ${UID}`,
	routerName: `GET ${UID}.DeviceLabel`,
	setRouterName: (name: string): string => `SET ${UID}.DeviceLabel=${name}`,
	/** Not in the manual. These are what the router's own web interface colours its ports from. */
	destinationDetail: `GET ${XP}.DestinationPortGuiStatus`,
	sourceDetail: `GET ${XP}.SourcePortGuiStatus`,
	/** The `*` includes the nodes below, which is where each preset is. What it announces hasn't been measured. */
	/** Changes to the presets that exist. Measured: a preset being added or deleted isn't announced here. */
	subscribePresets: `OPEN ${PRESETS}/*`,
	/** Presets being added, renamed or deleted, announced as NEW and DEL lines */
	subscribePresetList: `OPEN ${PRESETS}`,
	routes: `GET ${XP}.DestinationConnectionStatus`,
	/** Some models and firmwares may only have this older name. Not seen on a real router yet. */
	routesOlder: `GET ${XP}.DestinationConnectionList`,
	destinationStatus: `GET ${XP}.DestinationPortStatus`,
	sourceStatus: `GET ${XP}.SourcePortStatus`,
	names: `GET ${NAMES}.*`,
	presets: `GET ${PRESETS}`,
	softReset: 'CALL /SYS:softReset()',
	/** NORMAL or STANDBY. Measured: announced only to `OPEN /MANAGEMENT/POWER`. */
	power: `GET ${POWER}.Operation`,
	subscribePower: `OPEN ${POWER}`,
	standby: `CALL ${POWER}:standby()`,
	wakeUp: `CALL ${POWER}:wakeUp()`,
	inputHdcp: (input: number): string => `GET ${PORTS}/I${input}/SETTINGS.HdcpVersion`,
	outputHdcp: (output: number): string => `GET ${PORTS}/O${output}/SETTINGS.HdcpMode`,
	setInputHdcp: (input: number, value: string): string => `SET ${PORTS}/I${input}/SETTINGS.HdcpVersion=${value}`,
	setOutputHdcp: (output: number, value: string): string => `SET ${PORTS}/O${output}/SETTINGS.HdcpMode=${value}`,
	edidStatus: 'GET /EDID.EdidStatus',
	/** All of one property in a bank, such as F, which comes back quickly and in text order: F1, F10, F100 */
	edidBank: (bank: EdidBank, property: EdidProperty): string => `GET /EDID/${bank}/*.${property}`,
	/** Several in one command change together. The manual's comma form is refused. */
	switchEdid: (changes: { slot: string; input: number }[]): string =>
		`CALL /EDID:switch(${changes.map(({ slot, input }) => `${slot}:E${input}`).join(';')})`,
	copyEdid: (from: string, to: string): string => `CALL /EDID:copy(${from}:${to})`,
	deleteEdid: (slot: string): string => `CALL /EDID:delete(${slot})`,
	presetRoutes: (name: string): string => `GET ${PRESETS}/${name}.VideoDestination`,
	loadPreset: (name: string): string => `CALL ${PRESETS}/${name}:load()`,
	/** Measured: the brackets are needed, and it stores what is routed now */
	savePreset: (name: string): string => `CALL ${PRESETS}/${name}:save()`,
	/** Measured: these take the manual's comma form, unlike switch. A new preset holds what is routed now. */
	createPreset: (name: string): string => `CALL ${PRESETS}:create(${name},VIDEO)`,
	copyPreset: (from: string, to: string): string => `CALL ${PRESETS}:copy(${from},${to})`,
	renamePreset: (from: string, to: string): string => `CALL ${PRESETS}:rename(${from},${to})`,
	deletePreset: (name: string): string => `CALL ${PRESETS}:delete(${name})`,
	/**
	 * Measured: writes a preset's routes without routing anything, one entry per output and a trailing
	 * semicolon, in the form the router itself uses. A preset written this way loads normally.
	 */
	writePreset: (name: string, inputs: number[]): string =>
		`SET ${PRESETS}/${name}.VideoDestination=${inputs.map((input) => (input === 0 ? 'u0' : `uI${input}`)).join(';')};`,
	/** The front panel's preset buttons, as `Button1AssignedPreset=NAME` */
	slots: `GET ${PRESETS}.*`,
	/** What the front panel does: makes preset ButtonN from the current routes and gives it to slot N */
	createSlotPreset: (slot: number): string => `CALL ${PRESETS}:createButtonAssignedPreset(${slot},VIDEO)`,
	/** Several routes in one command change together, in a single change message */
	switch: (routes: Route[]): string => `CALL ${XP}:switch(${routes.map(routeText).join(';')})`,
	lock: (output: number): string => `CALL ${XP}:lockDestination(O${output})`,
	/** Measured: a locked input can't be routed anywhere, and freezes every output it is on */
	lockPort: (port: PortId): string => `CALL ${XP}:${port.startsWith('I') ? 'lockSource' : 'lockDestination'}(${port})`,
	unlockPort: (port: PortId): string =>
		`CALL ${XP}:${port.startsWith('I') ? 'unlockSource' : 'unlockDestination'}(${port})`,
	/** A muted port stays routed and sends black, without dropping the signal */
	mute: (port: PortId): string => `CALL ${XP}:${port.startsWith('I') ? 'muteSource' : 'muteDestination'}(${port})`,
	unmute: (port: PortId): string =>
		`CALL ${XP}:${port.startsWith('I') ? 'unmuteSource' : 'unmuteDestination'}(${port})`,
	/** An input's hotplug: OFF tells the source the router has gone, AUTO follows the source's 5V */
	inputHotplug: (input: number): string => `GET ${PORTS}/I${input}/SETTINGS.EnableHPD`,
	setInputHotplug: (input: number, on: boolean): string =>
		`SET ${PORTS}/I${input}/SETTINGS.EnableHPD=${on ? 'AUTO' : 'OFF'}`,
	/** An output's 5V: off looks to a display as if its cable was pulled */
	output5v: (output: number): string => `GET ${PORTS}/O${output}/SETTINGS.Enable5V`,
	setOutput5v: (output: number, on: boolean): string => `SET ${PORTS}/O${output}/SETTINGS.Enable5V=${on}`,
	unlock: (output: number): string => `CALL ${XP}:unlockDestination(O${output})`,
	rename: (port: PortId, prefix: string, name: string): string => `SET ${NAMES}.${port}=${prefix};${name}`,
}

/** Router error codes that have been seen, with what they turned out to mean */
export const ErrorCode = {
	syntax: 'E001',
	/** Also what the router says when there is nothing to do, such as unlocking an unlocked output */
	notExists: 'E002',
	invalidValue: 'E004',
	/** A switch to a locked output */
	accessDenied: 'E007',
	/** Creating a router preset with a name already in use */
	alreadyExists: 'E003',
	/** Standby while in standby, or waking while awake */
	illegalOperation: 'E006',
	/** Any change while the router is in standby: "Node disabled or standby mode active" */
	standby: 'E012',
} as const

/** Splits a byte stream into the router's CRLF terminated lines */
export class LineBuffer {
	#buffer = ''

	push(data: Buffer | string): string[] {
		this.#buffer += typeof data === 'string' ? data : data.toString('latin1')
		const lines = this.#buffer.split('\r\n')
		this.#buffer = lines.pop() ?? ''
		return lines
	}

	reset(): void {
		this.#buffer = ''
	}
}

export interface Property {
	path: string
	property: string
	value: string
}

/** `pr /A/B.Name=1`, `pw /A/B.Name=1` or `CHG /A/B.Name=1` */
export function parseProperty(line: string): Property | undefined {
	const match = /^(?:pr|pw|CHG)\s+(\S*?)\.([A-Za-z0-9_]+)=(.*)$/.exec(line)
	return match ? { path: match[1], property: match[2], value: match[3] } : undefined
}

export interface RouterError {
	code: string
	message: string
}

/** `mE /A:b %E007: Access denied`, and the same with pE or nE */
export function parseError(line: string): RouterError | undefined {
	const match = /^[mpn]E\s+\S+\s+%(E\d+):?\s*(.*)$/.exec(line)
	return match ? { code: match[1], message: match[2] } : undefined
}

/** The first error in a reply */
export const replyError = (lines: string[]): RouterError | undefined => {
	for (const line of lines) {
		const error = parseError(line)
		if (error) return error
	}
	return undefined
}

/** `I1;I2;0;` to its entries, without the empty one after the last `;` */
export function parseList(value: string): string[] {
	const entries = value.split(';')
	if (entries[entries.length - 1] === '') entries.pop()
	return entries
}

/** `I3` to 3 and `0` to 0, which means nothing is routed */
export function parseSource(entry: string): number | undefined {
	if (entry === '0') return 0
	const match = /^I(\d+)$/.exec(entry)
	return match ? Number(match[1]) : undefined
}

/** A preset's `uI1`: the leading letter is the port's state, then the source */
export function parsePresetSource(entry: string): number | undefined {
	const match = /^[A-Za-z]?(I\d+|0)$/.exec(entry)
	return match ? parseSource(match[1]) : undefined
}

export interface PortStatus {
	locked: boolean
	muted: boolean
	/** A cable with +5V: on an output, a display */
	connected: boolean
	signal: boolean
}

/**
 * `TFF` is a letter and two hex digits. T is free, L locked, M muted and U both, seen by locking a muted
 * output. In the last digit, bit 0 is the connection and bit 2 the signal, worked out from
 * these values while pulling cables: A neither, B connected only, E signal only, F both.
 */
export function parsePortStatus(entry: string): PortStatus | undefined {
	const match = /^([TLMU])[0-9A-Fa-f]([0-9A-Fa-f])$/.exec(entry)
	if (!match) return undefined
	const bits = parseInt(match[2], 16)
	return {
		locked: match[1] === 'L' || match[1] === 'U',
		muted: match[1] === 'M' || match[1] === 'U',
		connected: (bits & 0b0001) !== 0,
		signal: (bits & 0b0100) !== 0,
	}
}

/** The states in the legend of the router's own web interface */
export const PORT_LEGENDS = ['none', 'connected', 'dvi', 'hdmi', 'hdmi18'] as const
export type PortLegend = (typeof PORT_LEGENDS)[number]

/**
 * Follows the router's web interface. The first hex digit of its GUI status has the signal type in the
 * low two bits, 3 being HDMI, and the clock in the next two, 3 being up to 18G. Only `0`, `A` and `F`
 * have been seen, and only `A` with a real DVI source. DisplayPort has its own legend, not done yet.
 */
export function portLegend(status: PortStatus | undefined, detail: string | undefined): PortLegend {
	if (!status?.connected) return 'none'
	if (!status.signal) return 'connected'
	const bits = parseInt(detail?.charAt(0) ?? '0', 16)
	if ((bits & 0b0011) !== 0b0011) return 'dvi'
	return (bits & 0b1100) === 0b1100 ? 'hdmi18' : 'hdmi'
}

export interface PortName {
	port: PortId
	/** A number the router requires and stores but gives no meaning for. Sent back unchanged when renaming. */
	prefix: string
	name: string
}

/** The value of `/MEDIA/NAMES/VIDEO.I1`, such as `2;Input 1` */
export function parsePortName(port: string, value: string): PortName | undefined {
	const portMatch = /^[IO]\d+$/.exec(port)
	const separator = value.indexOf(';')
	if (!portMatch || separator === -1) return undefined
	return { port: port as PortId, prefix: value.slice(0, separator), name: unescapeValue(value.slice(separator + 1)) }
}

/** The router adds a backslash to some characters when it reports a value, such as \( \) \# \% \\ */
export function unescapeValue(value: string): string {
	return value.replace(/\\(.)/g, '$1')
}

/** The router mangles anything else, such as accents: `Café` reads back as `Caf` */
export function isValidName(name: string): boolean {
	return /^[\x20-\x7e]+$/.test(name)
}

/** Stand-ins for characters that don't reduce to a plain letter by removing an accent */
export const NAME_SUBSTITUTES: Record<string, string> = {
	ß: 'ss',
	ẞ: 'SS',
	æ: 'ae',
	Æ: 'AE',
	œ: 'oe',
	Œ: 'OE',
	ø: 'o',
	Ø: 'O',
	đ: 'd',
	Đ: 'D',
	ð: 'd',
	Ð: 'D',
	þ: 'th',
	Þ: 'Th',
	ł: 'l',
	Ł: 'L',
	ı: 'i',
	'\u00a0': ' ',
	'–': '-',
	'—': '-',
	'‘': "'",
	'’': "'",
	'“': '"',
	'”': '"',
	'…': '...',
	'×': 'x',
}

/**
 * The nearest name the router can store: `Café` to `Cafe`, with anything that has no plain version, such
 * as emoji, removed. A name that is already plain only loses its outer spaces.
 */
export function plainName(name: string): string {
	if (/^[\x20-\x7e]*$/.test(name)) return name.trim()
	return [...name.normalize('NFD')]
		.map((character) => NAME_SUBSTITUTES[character] ?? character)
		.join('')
		.replace(/[^\x20-\x7e]/g, '')
		.replace(/ {2,}/g, ' ')
		.trim()
}

/** The value of `/EDID.EdidStatus`, the EDID emulated on each input, such as `F137;F137` */
export function parseEdidStatus(value: string): string[] {
	return parseList(value)
}

/** `pr /EDID/F/F1.MonitorName=D640x480p60` to `F1` and the value */
export function parseEdidProperty(line: string): { slot: string; value: string } | undefined {
	const property = parseProperty(line)
	const slot = property && /^\/EDID\/[FDU]\/([FDU]\d+)$/.exec(property.path)?.[1]
	return property && slot ? { slot, value: property.value } : undefined
}

/** What to send for a name: no control characters, as they would end the command */
export function cleanName(name: string): string {
	// eslint-disable-next-line no-control-regex
	return name.replace(/[\x00-\x1f\x7f]/g, '').trim()
}

/** Child nodes from the reply to `GET /MEDIA/PRESET`, which are `n- /MEDIA/PRESET/NAME` */
export function parsePresetNames(lines: string[]): string[] {
	const names: string[] = []
	for (const line of lines) {
		const match = /^n-\s+\/MEDIA\/PRESET\/(\S+)$/.exec(line)
		if (match) names.push(match[1])
	}
	return names
}

/** `Button3AssignedPreset` to 3 */
export function parseSlot(property: string): number | undefined {
	const match = /^Button(\d+)AssignedPreset$/.exec(property)
	return match ? Number(match[1]) : undefined
}
